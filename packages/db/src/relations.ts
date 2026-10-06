import { relations } from "drizzle-orm/relations";
import { tenants, memberships, users, connectors, cases, caseTransitions, actions, approvalNonces, mspLinks, suppressions, tenantDeks, connectorCursors } from "./schema";

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

export const tenantsRelations = relations(tenants, ({many}) => ({
	memberships: many(memberships),
	connectors: many(connectors),
	cases: many(cases),
	caseTransitions: many(caseTransitions),
	actions: many(actions),
	approvalNonces: many(approvalNonces),
	mspLinks_mspTenantId: many(mspLinks, {
		relationName: "mspLinks_mspTenantId_tenants_id"
	}),
	mspLinks_clientTenantId: many(mspLinks, {
		relationName: "mspLinks_clientTenantId_tenants_id"
	}),
	suppressions: many(suppressions),
	tenantDeks: many(tenantDeks),
}));

export const usersRelations = relations(users, ({many}) => ({
	memberships: many(memberships),
	suppressions_createdBy: many(suppressions, {
		relationName: "suppressions_createdBy_users_id"
	}),
	suppressions_revokedBy: many(suppressions, {
		relationName: "suppressions_revokedBy_users_id"
	}),
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

export const suppressionsRelations = relations(suppressions, ({one}) => ({
	tenant: one(tenants, {
		fields: [suppressions.tenantId],
		references: [tenants.id]
	}),
	user_createdBy: one(users, {
		fields: [suppressions.createdBy],
		references: [users.id],
		relationName: "suppressions_createdBy_users_id"
	}),
	user_revokedBy: one(users, {
		fields: [suppressions.revokedBy],
		references: [users.id],
		relationName: "suppressions_revokedBy_users_id"
	}),
}));

export const tenantDeksRelations = relations(tenantDeks, ({one}) => ({
	tenant: one(tenants, {
		fields: [tenantDeks.tenantId],
		references: [tenants.id]
	}),
}));

export const connectorCursorsRelations = relations(connectorCursors, ({one}) => ({
	connector: one(connectors, {
		fields: [connectorCursors.connectorId],
		references: [connectors.id]
	}),
}));