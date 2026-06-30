/** Geographic coordinate (WGS84). */
export interface LatLng {
  lat: number;
  lng: number;
}

/** deck.gl / GeoJSON coordinate: [longitude, latitude]. */
export type LngLat = [number, number];

/** Route waypoint with optional timestamp for TripsLayer. */
export type RouteWaypoint = [number, number, number?];

export type RouteStatus =
  | "normal"
  | "at_risk"
  | "incident"
  | "recovery"
  | "completed";

export type VehicleStatus =
  | "idle"
  | "en_route"
  | "incident"
  | "completed";

export type OrderStatus =
  | "paid"
  | "pending"
  | "assigned"
  | "in_transit"
  | "delivered"
  | "cancelled";

export type IncidentType =
  | "vehicle_breakdown"
  | "congestion"
  | "driver_cancellation"
  | "payment_declined";

export type RoutingProviderName = "seed" | "osrm" | "cuopt-osrm";

export interface Driver {
  id: string;
  name: string;
  vehicleId: string;
}

export interface VehicleRoutingPlanStop {
  id: string;
  kind: "start" | "order" | "end";
  location: LatLng;
  etaSeconds: number;
  orderId: string | null;
}

export interface VehicleRoutingPlan {
  provider: RoutingProviderName;
  orderedStops: VehicleRoutingPlanStop[];
  assignedOrderIds: string[];
  totalDistanceMeters: number;
  totalDurationSeconds: number;
  routeStartAtSeconds?: number;
  geometryMode?: "road" | "fallback";
}

export interface Vehicle {
  id: string;
  driverId: string;
  route: LngLat[];
  routeStatus: RouteStatus;
  status: VehicleStatus;
  speedMps: number;
  routingProvider: RoutingProviderName;
  routingPlan: VehicleRoutingPlan | null;
  /** Sim seconds at which movement stops (breakdown). */
  frozenAtSeconds: number | null;
}

export interface PickupHub {
  id: string;
  name: string;
  location: LatLng;
}

export interface CustomerLocation {
  id: string;
  name: string;
  location: LatLng;
}

export interface Order {
  id: string;
  customerId: string;
  pickupHubId: string;
  vehicleId: string;
  status: OrderStatus;
  revenueCents: number;
  stripeCheckoutSessionId?: string | null;
  stripePaymentIntentId?: string | null;
  stripeEventId?: string | null;
}

export function isStripeBackedOrder(order: Order): boolean {
  return Boolean(
    order.stripeCheckoutSessionId ||
      order.stripePaymentIntentId ||
      order.stripeEventId,
  );
}

export function isStripeBackedActiveOrder(order: Order): boolean {
  return (
    isStripeBackedOrder(order) &&
    (order.status === "paid" ||
      order.status === "assigned" ||
      order.status === "in_transit")
  );
}

export function isStripeBackedOperationalOrder(order: Order): boolean {
  return (
    isStripeBackedOrder(order) &&
    (order.status === "assigned" ||
      order.status === "in_transit" ||
      order.status === "delivered")
  );
}

export interface Incident {
  id: string;
  type: IncidentType;
  vehicleId: string | null;
  orderIds: string[];
  createdAtSimSeconds: number;
}

export interface SimulationWorld {
  seed: number;
  breakdownVehicleId: string;
  drivers: Driver[];
  vehicles: Vehicle[];
  pickupHubs: PickupHub[];
  customers: CustomerLocation[];
  orders: Order[];
  incidents: Incident[];
}

/** RGB tuples for deck.gl layers (0–255). */
export const ROUTE_STATUS_COLORS: Record<RouteStatus, [number, number, number]> = {
  normal: [16, 185, 129],
  at_risk: [245, 158, 11],
  incident: [239, 68, 68],
  recovery: [99, 102, 241],
  completed: [148, 163, 184],
};

export const MAP_CENTER: LngLat = [-122.4, 37.785];
export const DEFAULT_MAP_ZOOM = 15;

export type * from "./simulator.js";

