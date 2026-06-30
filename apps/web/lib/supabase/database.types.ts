export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface Database {
  public: {
    Tables: {
      pickup_hubs: {
        Row: {
          id: string;
          name: string;
          lat: number;
          lng: number;
        };
        Insert: {
          id: string;
          name: string;
          lat: number;
          lng: number;
        };
        Update: Partial<Database["public"]["Tables"]["pickup_hubs"]["Insert"]>;
      };
      customer_locations: {
        Row: {
          id: string;
          name: string;
          lat: number;
          lng: number;
        };
        Insert: {
          id: string;
          name: string;
          lat: number;
          lng: number;
        };
        Update: Partial<
          Database["public"]["Tables"]["customer_locations"]["Insert"]
        >;
      };
      drivers: {
        Row: {
          id: string;
          name: string;
          stripe_payout_account_id: string | null;
          vehicle_id: string;
        };
        Insert: {
          id: string;
          name: string;
          stripe_payout_account_id?: string | null;
          vehicle_id: string;
        };
        Update: Partial<Database["public"]["Tables"]["drivers"]["Insert"]>;
      };
      vehicles: {
        Row: {
          id: string;
          driver_id: string;
          route: unknown;
          routing_plan: unknown | null;
          routing_provider: string;
          route_status: string;
          status: string;
          speed_mps: number;
          frozen_at_seconds: number | null;
        };
        Insert: {
          id: string;
          driver_id: string;
          route: unknown;
          routing_plan?: unknown | null;
          routing_provider?: string;
          route_status: string;
          status: string;
          speed_mps: number;
          frozen_at_seconds?: number | null;
        };
        Update: Partial<Database["public"]["Tables"]["vehicles"]["Insert"]>;
      };
      orders: {
        Row: {
          id: string;
          customer_id: string;
          pickup_hub_id: string;
          vehicle_id: string;
          status: string;
          revenue_cents: number;
          stripe_checkout_session_id: string | null;
          stripe_payment_intent_id: string | null;
          stripe_event_id: string | null;
          created_at: string;
        };
        Insert: {
          id: string;
          customer_id: string;
          pickup_hub_id: string;
          vehicle_id: string;
          status: string;
          revenue_cents: number;
          stripe_checkout_session_id?: string | null;
          stripe_payment_intent_id?: string | null;
          stripe_event_id?: string | null;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["orders"]["Insert"]>;
      };
      incidents: {
        Row: {
          id: string;
          type: string;
          vehicle_id: string | null;
          order_ids: unknown;
          created_at_sim_seconds: number;
          created_at: string;
        };
        Insert: {
          id: string;
          type: string;
          vehicle_id?: string | null;
          order_ids: unknown;
          created_at_sim_seconds: number;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["incidents"]["Insert"]>;
      };
      agent_decisions: {
        Row: Record<string, unknown>;
        Insert: Record<string, unknown>;
        Update: Record<string, unknown>;
      };
      ledger: {
        Row: {
          id: string;
          entry_type: string;
          amount_cents: number;
          reference_id: string | null;
          idempotency_key: string | null;
          stripe_reference: string | null;
          metadata: Json | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          entry_type: string;
          amount_cents: number;
          reference_id?: string | null;
          idempotency_key?: string | null;
          stripe_reference?: string | null;
          metadata?: Json | null;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["ledger"]["Insert"]>;
      };
      simulation_events: {
        Row: Record<string, unknown>;
        Insert: Record<string, unknown>;
        Update: Record<string, unknown>;
      };
      customer_notifications: {
        Row: Record<string, unknown>;
        Insert: Record<string, unknown>;
        Update: Record<string, unknown>;
      };
      policy_evaluations: {
        Row: Record<string, unknown>;
        Insert: Record<string, unknown>;
        Update: Record<string, unknown>;
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
