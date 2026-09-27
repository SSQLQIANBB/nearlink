import { DataTypes, Model, type InferAttributes, type InferCreationAttributes, type CreationOptional } from 'sequelize';
import sequelize from '../config/database';

export class RemoteDevice extends Model<InferAttributes<RemoteDevice>, InferCreationAttributes<RemoteDevice>> {
  declare id: string;
  declare ownerUserId: number;
  declare publicKey: string;
  declare fingerprint: string;
  declare keyVersion: CreationOptional<number>;
  declare alias: string;
  declare platform: 'macos' | 'windows';
  declare revokedAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
RemoteDevice.init({
  id: { type: DataTypes.UUID, primaryKey: true }, ownerUserId: { type: DataTypes.INTEGER, allowNull: false },
  publicKey: { type: DataTypes.TEXT, allowNull: false }, fingerprint: { type: DataTypes.STRING(64), allowNull: false, unique: true },
  keyVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
  alias: { type: DataTypes.STRING(80), allowNull: false }, platform: { type: DataTypes.STRING(16), allowNull: false },
  revokedAt: { type: DataTypes.DATE, allowNull: true, defaultValue: null },
  createdAt: DataTypes.DATE, updatedAt: DataTypes.DATE,
}, { sequelize, tableName: 'remote_devices', timestamps: true, indexes: [{ fields: ['ownerUserId', 'revokedAt'] }] });

export class AssistanceGrant extends Model<InferAttributes<AssistanceGrant>, InferCreationAttributes<AssistanceGrant>> {
  declare id: string;
  declare hostDeviceId: string;
  declare createdBySid: string;
  declare controllerUserId: number;
  declare expiresAt: Date | null;
  declare revokedAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
AssistanceGrant.init({
  id: { type: DataTypes.UUID, primaryKey: true }, hostDeviceId: { type: DataTypes.UUID, allowNull: false },
  createdBySid: { type: DataTypes.UUID, allowNull: false }, controllerUserId: { type: DataTypes.INTEGER, allowNull: false },
  expiresAt: { type: DataTypes.DATE, allowNull: true, defaultValue: null }, revokedAt: { type: DataTypes.DATE, allowNull: true, defaultValue: null },
  createdAt: DataTypes.DATE, updatedAt: DataTypes.DATE,
}, { sequelize, tableName: 'remote_assistance_grants', timestamps: true,
  indexes: [{ fields: ['controllerUserId', 'expiresAt'] }, { fields: ['hostDeviceId', 'revokedAt'] }, { fields: ['createdBySid'] }] });

export class RemoteSessionRecord extends Model<InferAttributes<RemoteSessionRecord>, InferCreationAttributes<RemoteSessionRecord>> {
  declare sessionId: string;
  declare requestId: CreationOptional<string | null>;
  declare requestHash: CreationOptional<string | null>;
  declare controllerEndpointId: CreationOptional<string | null>;
  declare grantCreatedBySid: CreationOptional<string | null>;
  declare controllerUserId: number;
  declare hostUserId: number;
  declare controllerSid: string;
  declare hostSid: string;
  declare hostDeviceId: string;
  declare grantId: string;
  declare scope: 'view' | 'control';
  declare state: string;
  declare revision: number;
  declare endedAt: CreationOptional<Date | null>;
  declare endReason: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
RemoteSessionRecord.init({
  requestId: { type: DataTypes.UUID, allowNull: true }, requestHash: { type: DataTypes.STRING(64), allowNull: true },
  controllerEndpointId: { type: DataTypes.STRING(128), allowNull: true }, grantCreatedBySid: { type: DataTypes.UUID, allowNull: true },
  sessionId: { type: DataTypes.UUID, primaryKey: true }, controllerUserId: { type: DataTypes.INTEGER, allowNull: false },
  hostUserId: { type: DataTypes.INTEGER, allowNull: false }, controllerSid: { type: DataTypes.UUID, allowNull: false },
  hostSid: { type: DataTypes.UUID, allowNull: false }, hostDeviceId: { type: DataTypes.UUID, allowNull: false },
  grantId: { type: DataTypes.UUID, allowNull: false }, scope: { type: DataTypes.STRING(16), allowNull: false },
  state: { type: DataTypes.STRING(24), allowNull: false }, revision: { type: DataTypes.INTEGER, allowNull: false },
  endedAt: { type: DataTypes.DATE, allowNull: true, defaultValue: null }, endReason: { type: DataTypes.STRING(64), allowNull: true, defaultValue: null },
  createdAt: DataTypes.DATE, updatedAt: DataTypes.DATE,
}, { sequelize, tableName: 'remote_sessions', timestamps: true,
  indexes: [{ unique: true, fields: ['controllerSid', 'requestId'] }, { fields: ['state', 'createdAt', 'sessionId'] }, { fields: ['state', 'updatedAt', 'sessionId'] }, { fields: ['grantCreatedBySid'] }, { fields: ['controllerUserId', 'createdAt'] }, { fields: ['hostUserId', 'createdAt'] }, { fields: ['controllerSid'] }, { fields: ['hostSid'] }] });

/** Event sequence is the state revision; -1 is reserved for unknown-time reconciliation. */
export class RemoteSessionEvent extends Model<InferAttributes<RemoteSessionEvent>, InferCreationAttributes<RemoteSessionEvent>> {
  declare sessionId: string;
  declare eventSeq: number;
  declare eventType: 'requested' | 'ended' | 'interrupted';
  declare reason: CreationOptional<string | null>;
  declare occurredAt: CreationOptional<Date | null>;
  declare observedAt: Date;
}
RemoteSessionEvent.init({
  sessionId: { type: DataTypes.UUID, primaryKey: true }, eventSeq: { type: DataTypes.INTEGER, primaryKey: true },
  eventType: { type: DataTypes.STRING(24), allowNull: false }, reason: { type: DataTypes.STRING(64), allowNull: true },
  occurredAt: { type: DataTypes.DATE, allowNull: true }, observedAt: { type: DataTypes.DATE, allowNull: false },
}, { sequelize, tableName: 'remote_session_events', timestamps: false, indexes: [{ fields: ['observedAt'] }] });
