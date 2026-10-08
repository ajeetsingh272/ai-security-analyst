/** Mirrors GET /msp/clients's response shape (apps/api/src/routes/msp.ts). */

export interface MspClientSummary {
  tenantId: string;
  name: string;
  openCriticalCount: number;
}

export interface MspClientsResponse {
  clients: MspClientSummary[];
}
