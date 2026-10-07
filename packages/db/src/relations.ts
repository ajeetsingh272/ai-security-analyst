import { relations } from "drizzle-orm/relations";
import { tenants, memberships, users, connectors, cases, caseTransitions, actions, approvalNonces, mspLinks, suppressions, tenantDeks, hotfixRules, entities, caseSignals, entityAliases, entityMerges, connectorCursors } from "./schema";

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
	entities: many(entities),
	caseSignals: many(caseSignals),
	entityAliases: many(entityAliases),
	entityMerges: many(entityMerges),
}));

export const usersRelations = relations(users, ({many}) => ({
	memberships: many(memberships),
	suppressions_createdBy: many(suppressions, {
		relationName: "suppressions_createdBy_users_id"
	}),
	suppressions_revokedBy: many(suppressions, {
		relationName: "suppressions_revokedBy_users_id"
	}),
	hotfixRules_createdBy: many(hotfixRules, {
		relationName: "hotfixRules_createdBy_users_id"
	}),
	hotfixRules_revokedBy: many(hotfixRules, {
		relationName: "hotfixRules_revokedBy_users_id"
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
	caseSignals: many(caseSignals),
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

export const hotfixRulesRelations = relations(hotfixRules, ({one}) => ({
	user_createdBy: one(users, {
		fields: [hotfixRules.createdBy],
		references: [users.id],
		relationName: "hotfixRules_createdBy_users_id"
	}),
	user_revokedBy: one(users, {
		fields: [hotfixRules.revokedBy],
		references: [users.id],
		relationName: "hotfixRules_revokedBy_users_id"
	}),
}));

export const entitiesRelations = relations(entities, ({one, many}) => ({
	tenant: one(tenants, {
		fields: [entities.tenantId],
		references: [tenants.id]
	}),
	entityAliases: many(entityAliases),
	entityMerges_fromEntityId: many(entityMerges, {
		relationName: "entityMerges_fromEntityId_entities_id"
	}),
	entityMerges_intoEntityId: many(entityMerges, {
		relationName: "entityMerges_intoEntityId_entities_id"
	}),
}));

export const caseSignalsRelations = relations(caseSignals, ({one}) => ({
	tenant: one(tenants, {
		fields: [caseSignals.tenantId],
		references: [tenants.id]
	}),
	case: one(cases, {
		fields: [caseSignals.caseId],
		references: [cases.id]
	}),
}));

export const entityAliasesRelations = relations(entityAliases, ({one}) => ({
	tenant: one(tenants, {
		fields: [entityAliases.tenantId],
		references: [tenants.id]
	}),
	entity: one(entities, {
		fields: [entityAliases.entityId],
		references: [entities.id]
	}),
}));

export const entityMergesRelations = relations(entityMerges, ({one}) => ({
	tenant: one(tenants, {
		fields: [entityMerges.tenantId],
		references: [tenants.id]
	}),
	entity_fromEntityId: one(entities, {
		fields: [entityMerges.fromEntityId],
		references: [entities.id],
		relationName: "entityMerges_fromEntityId_entities_id"
	}),
	entity_intoEntityId: one(entities, {
		fields: [entityMerges.intoEntityId],
		references: [entities.id],
		relationName: "entityMerges_intoEntityId_entities_id"
	}),
}));

export const connectorCursorsRelations = relations(connectorCursors, ({one}) => ({
	connector: one(connectors, {
		fields: [connectorCursors.connectorId],
		references: [connectors.id]
	}),
}));