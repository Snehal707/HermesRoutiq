import { z } from "zod";

export const incidentIdSchema = z.string().min(1);
export const driverIdSchema = z.string().min(1);
export const orderIdSchema = z.string().min(1);
export const vehicleIdSchema = z.string().min(1);
export const idempotencyKeySchema = z.string().min(8);

export const getBusinessSnapshotInputSchema = z.object({});
export const getActiveOrdersInputSchema = z.object({
  status: z.string().optional(),
});
export const getAvailableDriversInputSchema = z.object({});
export const getDriverLocationInputSchema = z.object({
  driverId: driverIdSchema,
});
export const previewPaidOrderDispatchInputSchema = z.object({
  orderId: orderIdSchema,
});
export const getIncidentDetailsInputSchema = z.object({
  incidentId: incidentIdSchema,
});
export const calculateFinancialExposureInputSchema = z.object({
  incidentId: incidentIdSchema,
});
export const requestRouteOptimisationInputSchema = z.object({
  incidentId: incidentIdSchema.optional(),
  routeStatus: z.enum(["normal", "at_risk", "incident", "recovery"]).default("recovery"),
});
export const compareRecoveryOptionsInputSchema = z.object({
  incidentId: incidentIdSchema,
});
export const checkSpendingPolicyInputSchema = z.object({
  actionType: z.string().min(1),
  amountCents: z.number().int().nonnegative(),
  incidentId: incidentIdSchema.optional(),
});
export const assignReplacementDriverInputSchema = z.object({
  vehicleId: vehicleIdSchema,
  driverId: driverIdSchema,
  orderIds: z.array(orderIdSchema).min(1),
});
export const applyCongestionRecoveryRouteInputSchema = z.object({
  incidentId: incidentIdSchema,
});
export const applyBreakdownRecoveryRerouteInputSchema = z.object({
  incidentId: incidentIdSchema,
  simulatePersistFailure: z.boolean().optional(),
});
export const dispatchPaidOrderInputSchema = z.object({
  orderId: orderIdSchema,
});
export const provisionEventSurgeCapacityInputSchema = z.object({
  eventType: z.string().min(1),
  threshold: z.number().int().positive(),
  windowSeconds: z.number().int().positive(),
  amountCents: z.number().int().positive(),
  serviceCategory: z.enum(["observability", "queue", "database"]),
  incidentId: incidentIdSchema.optional(),
  idempotencyKey: idempotencyKeySchema,
});
export const provisionInfrastructureInputSchema = z.object({
  infraType: z.enum(["queue", "observability"]),
  triggerReason: z.string().min(1).max(500),
  incidentId: incidentIdSchema.optional(),
});
export const createDriverPayoutInputSchema = z.object({
  driverId: driverIdSchema,
  amountCents: z.number().int().positive(),
  incidentId: incidentIdSchema.optional(),
  idempotencyKey: idempotencyKeySchema,
});
export const issueCustomerRefundInputSchema = z.object({
  orderId: orderIdSchema,
  amountCents: z.number().int().positive(),
  incidentId: incidentIdSchema.optional(),
  idempotencyKey: idempotencyKeySchema,
});
const checkoutOrderMetadataInputSchema = z.object({
  orderId: orderIdSchema,
  customerId: z.string().min(1),
  pickupHubId: z.string().min(1),
  quotedPriceCents: z.number().int().nonnegative(),
  vehicleId: vehicleIdSchema.optional(),
});
export const ensurePendingCheckoutOrderInputSchema = z.object({
  metadata: checkoutOrderMetadataInputSchema,
  stripeCheckoutSessionId: z.string().min(1),
});
export const markCheckoutOrderPaidInputSchema = z.object({
  metadata: checkoutOrderMetadataInputSchema,
  stripeEventId: z.string().min(1),
  stripeCheckoutSessionId: z.string().min(1),
  stripePaymentIntentId: z.string().min(1).nullable(),
});
export const recordPaymentDeclinedIncidentInputSchema = z.object({
  orderId: orderIdSchema,
  checkoutSessionId: z.string().min(1).nullable().optional(),
  stripeEventId: z.string().min(1).nullable().optional(),
  stripePaymentIntentId: z.string().min(1).nullable().optional(),
  errorMessage: z.string().min(1).nullable().optional(),
  declineCode: z.string().min(1).nullable().optional(),
});
export const sendCustomerNotificationInputSchema = z.object({
  orderId: orderIdSchema,
  channel: z.enum(["sms", "email", "push"]),
  message: z.string().min(1).max(500),
});
const operationalEventTypeSchema = z.enum([
  "order_intake_decision_completed",
  "paid_order_dispatch_completed",
  "paid_order_dispatch_deferred",
  "payment_recovery_contacted",
  "delivery_recovery_rerouted",
  "checkout_order_pending_created",
  "checkout_order_paid",
  "payment_declined_incident_created",
  "stripe_payment_failed",
  "payment_recovery_completed",
  "checkout_order_dispatch_requested",
  "checkout_order_dispatched",
  "checkout_order_dispatch_failed",
]);
export const recordOperationalEventInputSchema = z.object({
  eventType: operationalEventTypeSchema,
  payload: z.record(z.string(), z.unknown()),
});
export const completeDeliveryRecoveryInputSchema = z.object({
  incidentId: incidentIdSchema,
  orderIds: z.array(orderIdSchema).min(1),
  vehicleIds: z.array(vehicleIdSchema).min(1),
  incidentVehicleId: vehicleIdSchema,
});
export const verifyDeliveryRecoveryInputSchema = z.object({
  orderIds: z.array(orderIdSchema).min(1),
});
export const recordAgentDecisionInputSchema = z.object({
  incidentId: incidentIdSchema.optional(),
  reasoningSummary: z.string().min(1),
  options: z.array(z.record(z.string(), z.unknown())).min(1),
  selectedOption: z.record(z.string(), z.unknown()),
  expectedCostCents: z.number().int().nonnegative().optional(),
  expectedBenefitCents: z.number().int().nonnegative().optional(),
  policyResult: z.string().optional(),
});
export const createRecoverySkillInputSchema = z.object({
  skillName: z.string().min(1).default("vehicle_breakdown_recovery"),
  markdown: z.string().min(1),
  incidentId: incidentIdSchema.optional(),
  incidentType: z.string().min(1).optional(),
});

const latLngOutputSchema = z.object({
  lat: z.number(),
  lng: z.number(),
});

const orderedStopOutputSchema = z.object({
  id: z.string(),
  kind: z.enum(["start", "order", "end"]),
  etaSeconds: z.number(),
  orderId: z.string().nullable(),
  location: latLngOutputSchema,
});

const routePlanOutputSchema = z.object({
  provider: z.string(),
  assignedOrderIds: z.array(z.string()),
  totalDistanceMeters: z.number(),
  totalDurationSeconds: z.number(),
  orderedStops: z.array(orderedStopOutputSchema),
  routeStartAtSeconds: z.number().optional(),
  geometryMode: z.enum(["road", "fallback"]).optional(),
});

export const toolOutputSchemas = {
  get_business_snapshot: z.object({
    tick: z.object({
      elapsedSeconds: z.number(),
      speedMultiplier: z.number(),
      status: z.string(),
      seed: z.number(),
    }),
    summary: z.object({
      totalOrders: z.number(),
      activeOrders: z.number(),
      availableDrivers: z.number(),
      activeIncidents: z.number(),
      activeVehicleRoutes: z.number(),
    }),
  }),
  get_active_orders: z.object({
    orders: z.array(
      z.object({
        id: z.string(),
        customerId: z.string(),
        pickupHubId: z.string(),
        vehicleId: z.string(),
        status: z.string(),
        revenueCents: z.number(),
      }),
    ),
  }),
  get_available_drivers: z.object({
    drivers: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        vehicleId: z.string(),
      }),
    ),
  }),
  get_driver_location: z.object({
    driverId: z.string(),
    vehicleId: z.string(),
    status: z.string(),
    routeStatus: z.string(),
    location: latLngOutputSchema,
  }),
  preview_paid_order_dispatch: z.object({
    provider: z.string(),
    routeCount: z.number(),
    assignments: z.number(),
    unassignedOrderIds: z.array(z.string()),
    routes: z.array(
      z.object({
        vehicleId: z.string(),
        driverId: z.string(),
        route: z.array(z.tuple([z.number(), z.number()])),
        routingPlan: routePlanOutputSchema,
        routeStatus: z.string(),
      }),
    ),
  }),
  get_incident_details: z.object({
    incident: z.object({
      id: z.string(),
      type: z.string(),
      vehicleId: z.string().nullable(),
      orderIds: z.array(z.string()),
      createdAtSimSeconds: z.number(),
    }),
    orders: z.array(
      z.object({
        id: z.string(),
        vehicleId: z.string(),
        revenueCents: z.number(),
        status: z.string(),
      }),
    ),
  }),
  calculate_financial_exposure: z.object({
    incidentId: z.string(),
    impactedOrderCount: z.number(),
    revenueAtRiskCents: z.number(),
    estimatedRefundExposureCents: z.number(),
    estimatedReplacementCostCents: z.number(),
    estimatedNetExposureCents: z.number(),
  }),
  request_route_optimisation: z.object({
    provider: z.string(),
    routeCount: z.number(),
    assignments: z.number(),
    unassignedOrderIds: z.array(z.string()),
    routes: z.array(
      z.object({
        vehicleId: z.string(),
        driverId: z.string(),
        route: z.array(z.tuple([z.number(), z.number()])),
        routingPlan: routePlanOutputSchema,
        routeStatus: z.string(),
      }),
    ),
  }),
  compare_recovery_options: z.object({
    incidentId: z.string(),
    options: z.array(
      z.object({
        optionId: z.string(),
        label: z.string(),
        expectedCostCents: z.number(),
        expectedBenefitCents: z.number(),
        expectedNetBenefitCents: z.number(),
        expectedLateDeliveries: z.number(),
      }),
    ),
  }),
  check_spending_policy: z.object({
    allowed: z.boolean(),
    reason: z.string(),
    amountCents: z.number(),
    autoCapCents: z.number(),
  }),
  assign_replacement_driver: z.object({
    reassignedOrderIds: z.array(z.string()),
    driverId: z.string(),
    vehicleId: z.string(),
    routeStatus: z.string(),
  }),
  apply_congestion_recovery_route: z.object({
    incidentId: z.string(),
    vehicleId: z.string(),
    orderIds: z.array(z.string()),
    provider: z.string(),
    beforeRoute: z.array(z.tuple([z.number(), z.number()])),
    afterRoute: z.array(z.tuple([z.number(), z.number()])),
    beforeIntersectsCongestion: z.boolean(),
    afterIntersectsCongestion: z.boolean(),
    routeChanged: z.boolean(),
    routeCount: z.number(),
    orderAssignmentCount: z.number(),
    untouchedVehicleIds: z.array(z.string()),
  }),
  apply_breakdown_recovery_reroute: z.object({
    incidentId: z.string(),
    orderIds: z.array(z.string()),
    provider: z.string(),
    routeCount: z.number(),
    orderAssignmentCount: z.number(),
    replacementRoutes: z.array(
      z.object({
        vehicleId: z.string(),
        orderIds: z.array(z.string()),
        beforeRoute: z.array(z.tuple([z.number(), z.number()])),
        afterRoute: z.array(z.tuple([z.number(), z.number()])),
        routeChanged: z.boolean(),
      }),
    ),
    brokenVehicle: z.object({
      vehicleId: z.string(),
      beforeRoute: z.array(z.tuple([z.number(), z.number()])),
      afterRoute: z.array(z.tuple([z.number(), z.number()])),
      parkedLocation: z.tuple([z.number(), z.number()]),
    }),
    untouchedVehicleIds: z.array(z.string()),
  }),
  dispatch_paid_order: z.object({
    orderId: z.string(),
    dispatched: z.boolean(),
    assignedVehicleId: z.string().nullable(),
    provider: z.string(),
    routeCount: z.number(),
    orderAssignmentCount: z.number(),
    unassignedOrderIds: z.array(z.string()),
  }),
  provision_event_surge_capacity: z.object({
    created: z.boolean(),
    triggered: z.boolean(),
    eventType: z.string(),
    observedEventCount: z.number(),
    threshold: z.number(),
    windowSeconds: z.number(),
    amountCents: z.number(),
    serviceCategory: z.enum(["observability", "queue", "database"]),
    idempotencyKey: z.string(),
    stripeProductId: z.string().nullable(),
    stripePriceId: z.string().nullable(),
    policy: z.object({
      allowed: z.boolean(),
      reason: z.string(),
    }),
    note: z.string(),
  }),
  provision_infrastructure: z.object({
    created: z.boolean(),
    triggered: z.boolean(),
    infraType: z.enum(["queue", "observability"]),
    triggerReason: z.string(),
    triggerMetric: z.object({
      source: z.string(),
      observedCount: z.number(),
      threshold: z.number(),
    }),
    ledgerRowId: z.string().nullable(),
    stripeReference: z.string().nullable(),
    projectStatus: z.record(z.string(), z.unknown()),
    policy: z.object({
      allowed: z.boolean(),
      reason: z.string(),
    }),
  }),
  create_driver_payout: z.object({
    created: z.boolean(),
    driverId: z.string(),
    amountCents: z.number(),
    idempotencyKey: z.string(),
    stripeTransferId: z.string().nullable(),
    policy: z.object({
      allowed: z.boolean(),
      reason: z.string(),
    }),
  }),
  issue_customer_refund: z.object({
    created: z.boolean(),
    orderId: z.string(),
    amountCents: z.number(),
    idempotencyKey: z.string(),
    policy: z.object({
      allowed: z.boolean(),
      reason: z.string(),
    }),
  }),
  ensure_pending_checkout_order: z.object({
    orderId: z.string(),
    created: z.boolean(),
    status: z.string(),
  }),
  mark_checkout_order_paid: z.object({
    orderId: z.string(),
    created: z.boolean(),
    status: z.string(),
    resolvedIncidentId: z.string().nullable(),
  }),
  record_payment_declined_incident: z.object({
    incidentId: z.string(),
    orderId: z.string(),
    created: z.boolean(),
    status: z.literal("pending"),
  }),
  send_customer_notification: z.object({
    orderId: z.string(),
    channel: z.string(),
    message: z.string(),
    delivered: z.boolean(),
  }),
  record_operational_event: z.object({
    recorded: z.boolean(),
    eventType: operationalEventTypeSchema,
  }),
  complete_delivery_recovery: z.object({
    completed: z.boolean(),
    incidentId: z.string(),
    recoveredOrderIds: z.array(z.string()),
    replacementVehicleIds: z.array(z.string()),
    incidentVehicleId: z.string(),
  }),
  verify_delivery_recovery: z.object({
    recovered: z.boolean(),
    recoveredOrderIds: z.array(z.string()),
    unresolvedOrderIds: z.array(z.string()),
  }),
  record_agent_decision: z.object({
    recorded: z.boolean(),
    incidentId: z.string().nullable(),
  }),
  create_recovery_skill: z.object({
    written: z.boolean(),
    skillPath: z.string(),
    skillName: z.string(),
    metadataPath: z.string(),
  }),
} as const;

export const toolInputSchemas = {
  get_business_snapshot: getBusinessSnapshotInputSchema,
  get_active_orders: getActiveOrdersInputSchema,
  get_available_drivers: getAvailableDriversInputSchema,
  get_driver_location: getDriverLocationInputSchema,
  preview_paid_order_dispatch: previewPaidOrderDispatchInputSchema,
  get_incident_details: getIncidentDetailsInputSchema,
  calculate_financial_exposure: calculateFinancialExposureInputSchema,
  request_route_optimisation: requestRouteOptimisationInputSchema,
  compare_recovery_options: compareRecoveryOptionsInputSchema,
  check_spending_policy: checkSpendingPolicyInputSchema,
  assign_replacement_driver: assignReplacementDriverInputSchema,
  apply_congestion_recovery_route: applyCongestionRecoveryRouteInputSchema,
  apply_breakdown_recovery_reroute: applyBreakdownRecoveryRerouteInputSchema,
  dispatch_paid_order: dispatchPaidOrderInputSchema,
  provision_event_surge_capacity: provisionEventSurgeCapacityInputSchema,
  provision_infrastructure: provisionInfrastructureInputSchema,
  create_driver_payout: createDriverPayoutInputSchema,
  issue_customer_refund: issueCustomerRefundInputSchema,
  ensure_pending_checkout_order: ensurePendingCheckoutOrderInputSchema,
  mark_checkout_order_paid: markCheckoutOrderPaidInputSchema,
  record_payment_declined_incident: recordPaymentDeclinedIncidentInputSchema,
  send_customer_notification: sendCustomerNotificationInputSchema,
  record_operational_event: recordOperationalEventInputSchema,
  complete_delivery_recovery: completeDeliveryRecoveryInputSchema,
  verify_delivery_recovery: verifyDeliveryRecoveryInputSchema,
  record_agent_decision: recordAgentDecisionInputSchema,
  create_recovery_skill: createRecoverySkillInputSchema,
} as const;
