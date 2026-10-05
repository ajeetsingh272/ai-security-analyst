import { relations } from "drizzle-orm/relations";
import { tenants, mspLinks, memberships, users, connectors, cases, caseTransitions, actions, approvalNonces, connectorCursors } from "./schema";

export const mspLinksRelations = relations(mspLinks, ({one}) => ({
	tenant_mspTenantId: one(tenants, {
		fields: [mspLinks.mspTenantId],
		references: [tenants.id],
		relationName: "mspLinks_mspTenantId_tenants_id"
	}),
	tenant_clientTenantId: one(tenants, {
		fields: [mspLinks.clientTenantId],
		references: [tenants.id],
		relationName: "mspLinks_clientTenantId_tenants_id"
	}),
}));

export const tenantsRelations = relations(tenants, ({many}) => ({
	mspLinks_mspTenantId: many(mspLinks, {
		relationName: "mspLinks_mspTenantId_tenants_id"
	}),
	mspLinks_clientTenantId: many(mspLinks, {
		relationName: "mspLinks_clientTenantId_tenants_id"
	}),
	memberships: many(memberships),
	connectors: many(connectors),
	cases: many(cases),
	caseTransitions: many(caseTransitions),
	actions: many(actions),
	approvalNonces: many(approvalNonces),
}));

export const membershipsRelations = relations(memberships, ({one}) => ({
	tenant: one(tenants, {
		fields: [memberships.tenantId],
		references: [tenants.id]
	}),
	user: one(users, {
		fields: [memberships.userId],
		references: [users.id]
	}),
}));

export const usersRelations = relations(users, ({many}) => ({
	memberships: many(memberships),
}));

export const connectorsRelations = relations(connectors, ({one, many}) => ({
	tenant: one(tenants, {
		fields: [connectors.tenantId],
		references: [tenants.id]
	}),
	connectorCursors: many(connectorCursors),
}));

export const casesRelations = relations(cases, ({one, many}) => ({
	tenant: one(tenants, {
		fields: [cases.tenantId],
		references: [tenants.id]
	}),
	caseTransitions: many(caseTransitions),
	actions: many(actions),
}));

export const caseTransitionsRelations = relations(caseTransitions, ({one}) => ({
	tenant: one(tenants, {
		fields: [caseTransitions.tenantId],
		references: [tenants.id]
	}),
	case: one(cases, {
		fields: [caseTransitions.caseId],
		references: [cases.id]
	}),
}));

export const actionsRelations = relations(actions, ({one, many}) => ({
	tenant: one(tenants, {
		fields: [actions.tenantId],
		references: [tenants.id]
	}),
	case: one(cases, {
		fields: [actions.caseId],
		references: [cases.id]
	}),
	approvalNonces: many(approvalNonces),
}));

export const approvalNoncesRelations = relations(approvalNonces, ({one}) => ({
	action: one(actions, {
		fields: [approvalNonces.actionId],
		references: [actions.id]
	}),
	tenant: one(tenants, {
		fields: [approvalNonces.tenantId],
		references: [tenants.id]
	}),
}));

export const connectorCursorsRelations = relations(connectorCursors, ({one}) => ({
	connector: one(connectors, {
		fields: [connectorCursors.connectorId],
		references: [connectors.id]
	}),
}));