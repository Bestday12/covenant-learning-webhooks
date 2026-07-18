import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: "2025-06-30.basil",
});

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

export const config = {
    api: {
        bodyParser: false,
    },
};

async function readRawBody(req) {
    const chunks = [];

    for await (const chunk of req) {
        chunks.push(chunk);
    }

    return Buffer.concat(chunks);
}

export default async function handler(req, res) {

    if (req.method !== "POST") {
        return res.status(405).send("Method Not Allowed");
    }

    let event;

    try {

        const rawBody = await readRawBody(req);

        const signature = req.headers["stripe-signature"];

        event = stripe.webhooks.constructEvent(
            rawBody,
            signature,
            endpointSecret
        );

    } catch (err) {

        console.error("❌ Signature verification failed:", err.message);

        return res.status(400).send(err.message);

    }

    //-------------------------------------------------------
    // Ignore events we don't care about
    //-------------------------------------------------------

    if (event.type !== "checkout.session.completed") {
        return res.status(200).json({ received: true });
    }

    //-------------------------------------------------------
    // Prevent duplicate processing
    //-------------------------------------------------------

    const { data: processed } = await supabase
        .from("stripe_events")
        .select("id")
        .eq("id", event.id)
        .maybeSingle();

    if (processed) {

        console.log("Webhook already processed:", event.id);

        return res.status(200).json({
            received: true,
            duplicate: true
        });

    }

    try {

        const session = event.data.object;

        //-------------------------------------------------------
        // Get purchased price
        //-------------------------------------------------------

        const lineItems =
            await stripe.checkout.sessions.listLineItems(
                session.id,
                {
                    limit: 1
                }
            );

        if (!lineItems.data.length) {
            throw new Error("No line items found.");
        }

        const priceId = lineItems.data[0].price.id;

        console.log("Stripe Price:", priceId);

        //-------------------------------------------------------
        // Find course
        //-------------------------------------------------------

        const {
            data: course,
            error: courseError
        } = await supabase
            .from("courses")
            .select("id,title")
            .eq("stripe_price_id", priceId)
            .single();

        if (courseError) {
            throw courseError;
        }

        if (!course) {
            throw new Error("Course not found.");
        }

        //-------------------------------------------------------
        // Customer email
        //-------------------------------------------------------

        const email =
            session.customer_details?.email ??
            session.customer_email;

        if (!email) {
            throw new Error("Customer email missing.");
        }

        //-------------------------------------------------------
        // Existing profile?
        //-------------------------------------------------------

        let {
            data: profile,
            error: profileError
        } = await supabase
            .from("profiles")
            .select("*")
            .eq("email", email)
            .maybeSingle();

        if (profileError) {
            throw profileError;
        }

        //-------------------------------------------------------
        // Create Auth User
        //-------------------------------------------------------

        if (!profile) {

            console.log("Creating user:", email);

            const result =
                await supabase.auth.admin.createUser({

                    email,

                    email_confirm: true,

                    user_metadata: {

                        full_name:
                            session.customer_details?.name ?? ""

                    }

                });

            if (result.error) {
                throw result.error;
            }

            //-------------------------------------------------------
            // Wait for profile trigger
            //-------------------------------------------------------

            let attempts = 20;

            while (attempts--) {

                await new Promise(r => setTimeout(r, 500));

                const response =
                    await supabase
                        .from("profiles")
                        .select("*")
                        .eq("id", result.data.user.id)
                        .maybeSingle();

                if (response.data) {

                    profile = response.data;

                    break;

                }

            }

            if (!profile) {
                throw new Error("Profile creation timeout.");
            }

        }

        //-------------------------------------------------------
        // Save Stripe Customer ID
        //-------------------------------------------------------

        if (
            session.customer &&
            !profile.stripe_customer_id
        ) {

            const { error } = await supabase
                .from("profiles")
                .update({
                    stripe_customer_id: session.customer
                })
                .eq("id", profile.id);

            if (error) {
                throw error;
            }

        }

        //-------------------------------------------------------
        // Existing enrolment?
        //-------------------------------------------------------

        const {
            data: existing,
            error: enrolError
        } = await supabase
            .from("enrollments")
            .select("id")
            .eq("user_id", profile.id)
            .eq("course_id", course.id)
            .maybeSingle();

        if (enrolError) {
            throw enrolError;
        }

        if (!existing) {

            const { error } = await supabase
                .from("enrollments")
                .insert({

                    user_id: profile.id,

                    course_id: course.id,

                    enrolled_at: new Date().toISOString()

                });

            if (error) {
                throw error;
            }

            console.log("✅ Enrolment created.");

        } else {

            console.log("User already enrolled.");

        }

        //-------------------------------------------------------
        // Mark webhook processed
        //-------------------------------------------------------

        const { error: eventError } =
            await supabase
                .from("stripe_events")
                .insert({
                    id: event.id
                });

        if (eventError) {
            throw eventError;
        }

        console.log(
            `✅ ${email} enrolled into "${course.title}"`
        );

    } catch (err) {

        console.error("Webhook Error:", err);

        return res.status(500).send(err.message);

    }

    return res.status(200).json({
        received: true
    });

}