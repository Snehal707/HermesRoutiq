export const MCP_TOOL_NAMES = [
  "get_business_snapshot",
  "get_active_orders",
  "get_available_drivers",
  "get_driver_location",
  "preview_paid_order_dispatch",
  "get_incident_details",
  "calculate_financial_exposure",
  "request_route_optimisation",
  "compare_recovery_options",
  "check_spending_policy",
  "assign_replacement_driver",
  "apply_congestion_recovery_route",
  "apply_breakdown_recovery_reroute",
  "dispatch_paid_order",
  "provision_event_surge_capacity",
  "provision_infrastructure",
  "create_driver_payout",
  "issue_customer_refund",
  "ensure_pending_checkout_order",
  "mark_checkout_order_paid",
  "record_payment_declined_incident",
  "send_customer_notification",
  "record_operational_event",
  "complete_delivery_recovery",
  "verify_delivery_recovery",
  "record_agent_decision",
  "create_recovery_skill",
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

export const MCP_READ_TOOL_NAMES = [
  "get_business_snapshot",
  "get_active_orders",
  "get_available_drivers",
  "get_driver_location",
  "preview_paid_order_dispatch",
  "get_incident_details",
  "calculate_financial_exposure",
  "compare_recovery_options",
] as const;

export type McpReadToolName = (typeof MCP_READ_TOOL_NAMES)[number];

export const MCP_ACTION_TOOL_NAMES = [
  "request_route_optimisation",
  "check_spending_policy",
  "assign_replacement_driver",
  "apply_congestion_recovery_route",
  "apply_breakdown_recovery_reroute",
  "dispatch_paid_order",
  "provision_event_surge_capacity",
  "provision_infrastructure",
  "create_driver_payout",
  "issue_customer_refund",
  "ensure_pending_checkout_order",
  "mark_checkout_order_paid",
  "record_payment_declined_incident",
  "send_customer_notification",
  "record_operational_event",
  "complete_delivery_recovery",
  "verify_delivery_recovery",
  "record_agent_decision",
  "create_recovery_skill",
] as const;

export type McpActionToolName = (typeof MCP_ACTION_TOOL_NAMES)[number];
