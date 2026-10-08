import { relations } from "drizzle-orm/relations";
import { tenants, memberships, users, caseTransitions, cases, actions, approvalNonces, mspLinks, suppressions, tenantDeks, connectors, hotfixRules, entities, entityAliases, caseSignals, scanJobs, baselineCursors, entityMerges, llmUsage, analystDegradedQueue, tenantNotificationPreferences, investigationTranscripts, notificationDeliveries, tenantPreApprovals, notificationRecipientOptouts, connectorCursors, entityCriticality } from "./schema";

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
	cases: many(cases),
	connectors: many(connectors),
	entities: many(entities),
	entityAliases: many(entityAliases),
	caseSignals: many(caseSignals),
	scanJobs: many(scanJobs),
	baselineCursors: many(baselineCursors),
	entityMerges: many(entityMerges),
	llmUsages: many(llmUsage),
	analystDegradedQueues: many(analystDegradedQueue),
	tenantNotificationPreferences: many(tenantNotificationPreferences),
	investigationTranscripts: many(investigationTranscripts),
	notificationDeliveries: many(notificationDeliveries),
	tenantPreApprovals: many(tenantPreApprovals),
	notificationRecipientOptouts: many(notificationRecipientOptouts),
	entityCriticalities: many(entityCriticality),
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
	scanJobs: many(scanJobs),
	tenantPreApprovals_grantedBy: many(tenantPreApprovals, {
		relationName: "tenantPreApprovals_grantedBy_users_id"
	}),
	tenantPreApprovals_revokedBy: many(tenantPreApprovals, {
		relationName: "tenantPreApprovals_revokedBy_users_id"
	}),
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

export const casesRelations = relations(cases, ({one, many}) => ({
	caseTransitions: many(caseTransitions),
	actions: many(actions),
	tenant: one(tenants, {
		fields: [cases.tenantId],
		references: [tenants.id]
	}),
	caseSignals: many(caseSignals),
	llmUsages: many(llmUsage),
	analystDegradedQueues: many(analystDegradedQueue),
	investigationTranscripts: many(investigationTranscripts),
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

export const connectorsRelations = relations(connectors, ({one, many}) => ({
	tenant: one(tenants, {
		fields: [connectors.tenantId],
		references: [tenants.id]
	}),
	connectorCursors: many(connectorCursors),
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

export const scanJobsRelations = relations(scanJobs, ({one}) => ({
	tenant: one(tenants, {
		fields: [scanJobs.tenantId],
		references: [tenants.id]
	}),
	user: one(users, {
		fields: [scanJobs.createdBy],
		references: [users.id]
	}),
}));

export const baselineCursorsRelations = relations(baselineCursors, ({one}) => ({
	tenant: one(tenants, {
		fields: [baselineCursors.tenantId],
		references: [tenants.id]
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

export const llmUsageRelations = relations(llmUsage, ({one}) => ({
	tenant: one(tenants, {
		fields: [llmUsage.tenantId],
		references: [tenants.id]
	}),
	case: one(cases, {
		fields: [llmUsage.caseId],
		references: [cases.id]
	}),
}));

export const analystDegradedQueueRelations = relations(analystDegradedQueue, ({one}) => ({
	tenant: one(tenants, {
		fields: [analystDegradedQueue.tenantId],
		references: [tenants.id]
	}),
	case: one(cases, {
		fields: [analystDegradedQueue.caseId],
		references: [cases.id]
	}),
}));

export const tenantNotificationPreferencesRelations = relations(tenantNotificationPreferences, ({one}) => ({
	tenant: one(tenants, {
		fields: [tenantNotificationPreferences.tenantId],
		references: [tenants.id]
	}),
}));

export const investigationTranscriptsRelations = relations(investigationTranscripts, ({one}) => ({
	tenant: one(tenants, {
		fields: [investigationTranscripts.tenantId],
		references: [tenants.id]
	}),
	case: one(cases, {
		fields: [investigationTranscripts.caseId],
		references: [cases.id]
	}),
}));

export const notificationDeliveriesRelations = relations(notificationDeliveries, ({one}) => ({
	tenant: one(tenants, {
		fields: [notificationDeliveries.tenantId],
		references: [tenants.id]
	}),
}));

export const tenantPreApprovalsRelations = relations(tenantPreApprovals, ({one}) => ({
	tenant: one(tenants, {
		fields: [tenantPreApprovals.tenantId],
		references: [tenants.id]
	}),
	user_grantedBy: one(users, {
		fields: [tenantPreApprovals.grantedBy],
		references: [users.id],
		relationName: "tenantPreApprovals_grantedBy_users_id"
	}),
	user_revokedBy: one(users, {
		fields: [tenantPreApprovals.revokedBy],
		references: [users.id],
		relationName: "tenantPreApprovals_revokedBy_users_id"
	}),
}));

export const notificationRecipientOptoutsRelations = relations(notificationRecipientOptouts, ({one}) => ({
	tenant: one(tenants, {
		fields: [notificationRecipientOptouts.tenantId],
		references: [tenants.id]
	}),
}));

export const connectorCursorsRelations = relations(connectorCursors, ({one}) => ({
	connector: one(connectors, {
		fields: [connectorCursors.connectorId],
		references: [connectors.id]
	}),
}));

export const entityCriticalityRelations = relations(entityCriticality, ({one}) => ({
	tenant: one(tenants, {
		fields: [entityCriticality.tenantId],
		references: [tenants.id]
	}),
}));