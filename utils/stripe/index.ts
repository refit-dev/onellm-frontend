/* eslint-disable no-console */
/* eslint-disable camelcase */
import { stripe } from "@/lib/stripe";
import supabase from "@/pages/api/supabase-server.component";
import { OneLLMPayment, OneLLMSubscription } from "@/types/table";
import Stripe from "stripe";

type PeriodItem = { price?: { id?: string } | null };
type PeriodField = 'current_period_start' | 'current_period_end';
type PlanItem = (items: PeriodItem[]) => PeriodItem | undefined;

// Typed like the removed field, which was also absent at runtime when Stripe omitted it.
function subscriptionPeriod(subscription: object, field: PeriodField, planItem?: PlanItem): number {
  const legacy: unknown = Reflect.get(subscription, field);
  if (typeof legacy === 'number') return legacy;
  const list: unknown = Reflect.get(subscription, 'items');
  const data: unknown = list && typeof list === 'object' ? Reflect.get(list, 'data') : undefined;
  const items = (Array.isArray(data) ? data : []).filter(
    (item): item is PeriodItem => typeof item === 'object' && item !== null,
  );
  const periods = new Set(items.map((item) => Reflect.get(item, field)));
  const chosen = periods.size === 1 ? items[0] : planItem?.(items);
  const value: unknown = chosen ? Reflect.get(chosen, field) : undefined;
  return (typeof value === 'number' ? value : undefined) as number;
}

function getSubscriptionPeriodStart(subscription: object, planItem?: PlanItem): number {
  return subscriptionPeriod(subscription, 'current_period_start', planItem);
}

function getSubscriptionPeriodEnd(subscription: object, planItem?: PlanItem): number {
  return subscriptionPeriod(subscription, 'current_period_end', planItem);
}

export const toDateTime = (secs: number) => {
  const t = new Date("1970-01-01T00:30:00Z"); // Unix epoch start.
  t.setSeconds(secs);
  return t;
};

/**
 * Copies the billing details from the payment method to the customer object.
 */
export const copyBillingDetailsToCustomer = async (
  userId: string,
  payment_method: Stripe.PaymentMethod
) => {
  const customer = payment_method.customer as string;
  const { name, phone, address } = payment_method.billing_details;
  if (!name || !phone || !address) return;
  await stripe.customers.update(customer, {
    name,
    phone,
    address: {
      city: address.city ?? undefined,
      country: address.country ?? undefined,
      line1: address.line1 ?? undefined,
      line2: address.line2 ?? undefined,
      postal_code: address.postal_code ?? undefined,
      state: address.state ?? undefined,
    },
  });

  // Update the user object with the billing address and payment method.
  const { data: user, error } = await supabase
    .from("users")
    .update({
      billing_address: { ...address },
      payment_method: JSON.stringify(payment_method[payment_method.type as Extract<Stripe.PaymentMethod.Type, keyof Stripe.PaymentMethod>]),
    })
    .eq("id", userId)
    .select("*");

  if (error) {
    throw error;
  }

  console.log(`Updated user [${user?.[0]?.id}] with billing details.`);
};

export const manageSubscriptionStatusChange = async (
  subscriptionId: string,
  customerId: string,
  createAction = false
) => {
  const { data: user, error } = await supabase
    .from("users")
    .select("*")
    .eq("stripe_customer_id", customerId)
    .single();

  if (error || !user) {
    throw error;
  }

  console.log(
    `User [${user?.id}] is changing subscription [${subscriptionId}] wth customer [${customerId}]`
  );

  if (!user) {
    throw new Error("User not found.");
  }

  const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ["default_payment_method"],
  });

  if (!subscription) {
    throw new Error(`Subscription not found: ${subscriptionId}`);
  }

  // Upsert the latest status of the subscription object.
  const subscriptionData: OneLLMSubscription = {
    id: subscription.id,
    owner_id: user.id,
    customer_id: customerId,
    metadata: subscription.metadata,
    status: subscription.status,
    price_id: subscription.items.data[0].price.id,
    quantity: subscription.items.data[0].quantity
      ? subscription.items.data[0].quantity
      : null,
    cancel_at_period_end: subscription.cancel_at_period_end,
    cancel_at: subscription.cancel_at
      ? toDateTime(subscription.cancel_at).toISOString()
      : null,
    canceled_at: subscription.canceled_at
      ? toDateTime(subscription.canceled_at).toISOString()
      : null,
    current_period_start: toDateTime(
      (getSubscriptionPeriodStart(subscription, (items) => items[0]))
    ).toISOString(),
    current_period_end: toDateTime(
      (getSubscriptionPeriodEnd(subscription, (items) => items[0]))
    ).toISOString(),
    created: toDateTime(subscription.created).toISOString(),
    ended_at: subscription.ended_at
      ? toDateTime(subscription.ended_at).toISOString()
      : null,
    trial_start: subscription.trial_start
      ? toDateTime(subscription.trial_start).toISOString()
      : null,
    trial_end: subscription.trial_end
      ? toDateTime(subscription.trial_end).toISOString()
      : null,
    product_id: subscription.items.data?.[0]?.plan.product as string,
  };

  const { data: upsertResponse, error: upsertError } = await supabase
    .from("subscriptions")
    .upsert(subscriptionData)
    .select("*");

  if (upsertError) {
    throw upsertError;
  }

  const result = upsertResponse?.[0];

  console.log(upsertResponse);

  console.log(
    `Inserted/updated subscription [${result.id}] for user [${result.owner_id}]`
  );

  // For a new subscription copy the billing details to the customer object.
  // NOTE: This is a costly operation and should happen at the very end.
  //   if (createAction && subscription.default_payment_method && user.id)
  //     await copyBillingDetailsToCustomer(
  //       user.id,
  //       subscription.default_payment_method as Stripe.PaymentMethod
  //     );
};

export const upsertPaymentIntentRecord = async (
  paymentIntentId: string,
  userId: string,
  customerId: string
) => {
  const { data: user, error } = await supabase
    .from("users")
    .select("*")
    .eq("stripe_customer_id", customerId)
    .single();

  if (error || !user) {
    throw error;
  }

  console.log(
    `User [${user?.id}] is changing payment [${paymentIntentId}] wth customer [${customerId}]`
  );

  if (!user) {
    throw new Error("User not found.");
  }

  // Get payment intent from Stripe.
  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
  if (!paymentIntent) {
    throw new Error(`Payment intent not found: ${paymentIntentId}`);
  }

  const payment: OneLLMPayment = {
    id: paymentIntentId,
    owner_id: user.id,
    currency: paymentIntent.currency,
    amount: paymentIntent.amount,
    status: paymentIntent.status,
    metadata: paymentIntent.metadata,
    created: toDateTime(paymentIntent.created).toISOString(),
    canceled_at: paymentIntent.canceled_at
      ? toDateTime(paymentIntent.canceled_at).toISOString()
      : null,
    created_at: toDateTime(paymentIntent.created).toISOString(),
    updated_at: toDateTime(paymentIntent.created).toISOString(),
  };

  const { data: paymentIntentRecord, error: paymentIntentError } =
    await supabase.from("payments").upsert(payment).select("*");

  if (paymentIntentError) {
    throw paymentIntentError;
  }

  console.log(
    `Inserted/updated payment intent [${paymentIntentRecord?.[0]?.id}] for user [${paymentIntentRecord?.[0]?.owner_id}]`
  );
};
