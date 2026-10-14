import { DataTypes, Model } from 'sequelize';
import sequelize from '../config/database';

export interface LoginSessionAttributes {
  id: string;
  userId: number;
  authVersion: string;
  refreshHash: string;
  version: number;
  expiresAt: Date;
  revokedAt?: Date | null;
  rotationRequestId?: string | null;
  rotationInputHash?: string | null;
  rotationResponse?: string | null;
  rotationExpiresAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

class LoginSession extends Model<LoginSessionAttributes> implements LoginSessionAttributes {
  declare id: string;
  declare userId: number;
  declare authVersion: string;
  declare refreshHash: string;
  declare version: number;
  declare expiresAt: Date;
  declare revokedAt: Date | null;
  declare rotationRequestId: string | null;
  declare rotationInputHash: string | null;
  declare rotationResponse: string | null;
  declare rotationExpiresAt: Date | null;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;
}

LoginSession.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true },
    userId: { type: DataTypes.INTEGER, allowNull: false },
    authVersion: { type: DataTypes.UUID, allowNull: false },
    refreshHash: { type: DataTypes.STRING(64), allowNull: false },
    version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    revokedAt: { type: DataTypes.DATE, allowNull: true },
    rotationRequestId: { type: DataTypes.STRING(128), allowNull: true },
    rotationInputHash: { type: DataTypes.STRING(64), allowNull: true },
    rotationResponse: { type: DataTypes.TEXT, allowNull: true },
    rotationExpiresAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize,
    tableName: 'login_sessions',
    timestamps: true,
    indexes: [{ fields: ['userId', 'revokedAt', 'expiresAt'] }],
  },
);

export default LoginSession;
