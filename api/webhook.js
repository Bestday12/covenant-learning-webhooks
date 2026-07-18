import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

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

    for await (const chunk of req)
        chunks.push(chunk);

    return Buffer.concat(chunks);

}

export default async function handler(req, res) {

    if (req.method !== "POST")
        return res.status(405).send("Method Not Allowed");

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

        console.error(err);

        return res.status(400).send(err.message);

    }

    if (event.type !== "checkout.session.completed")
        return res.status(200).json({ received: true });

    try {

        const session = event.data.object;

        //-------------------------------------------------------
        // Expand line items
        //-------------------------------------------------------

        const lineItems = await stripe.checkout.sessions.listLineItems(
            session.id,
            {
                limit: 1
            }
        );

        if (!lineItems.data.length)
            throw new Error("No line items");

        const priceId = lineItems.data[0].price.id;

        //-------------------------------------------------------
        // Find course
        //-------------------------------------------------------

        const { data: course } = await supabase
            .from("courses")
            .select("id")
            .eq("stripe_price_id", priceId)
            .single();

        if (!course)
            throw new Error("Course not found");

        //-------------------------------------------------------
        // Customer email
        //-------------------------------------------------------

        const email =
            session.customer_details?.email ??
            session.customer_email;

        if (!email)
            throw new Error("Customer email missing");

        //-------------------------------------------------------
        // Find existing profile
        //-------------------------------------------------------

        let { data: profile } = await supabase
            .from("profiles")
            .select("*")
            .eq("email", email)
            .single();

        //-------------------------------------------------------
        // Create Auth User
        //-------------------------------------------------------

        if (!profile) {

            const result =
                await supabase.auth.admin.createUser({

                    email,

                    email_confirm: true,

                    user_metadata: {

                        full_name:
                            session.customer_details?.name ?? ""

                    }

                });

            if (result.error)
                throw result.error;

            //--------------------------------------------------

            let attempts = 10;

            while (attempts--) {

                await new Promise(r => setTimeout(r, 500));

                const response = await supabase
                    .from("profiles")
                    .select("*")
                    .eq("id", result.data.user.id)
                    .single();

                if (response.data) {

                    profile = response.data;

                    break;

                }

            }

            if (!profile)
                throw new Error("Profile creation failed");

        }

        //-------------------------------------------------------
        // Update Stripe Customer ID
        //-------------------------------------------------------

        if (
            session.customer &&
            !profile.stripe_customer_id
        ) {

            await supabase
                .from("profiles")
                .update({
                    stripe_customer_id: session.customer
                })
                .eq("id", profile.id);

        }

        //-------------------------------------------------------
        // Existing enrolment?
        //-------------------------------------------------------

        const { data: existing } = await supabase
            .from("enrollments")
            .select("id")
            .eq("user_id", profile.id)
            .eq("course_id", course.id)
            .maybeSingle();

        if (!existing) {

            await supabase
                .from("enrollments")
                .insert({

                    user_id: profile.id,

                    course_id: course.id,

                    enrolled_at: new Date().toISOString()

                });

        }

        console.log(
            `${email} enrolled into ${course.id}`
        );

    } catch (err) {

        console.error(err);

        return res.status(500).send(err.message);

    }

    return res.status(200).json({

        received: true

    });

}