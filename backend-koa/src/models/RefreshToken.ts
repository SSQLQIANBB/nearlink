import { DataTypes, Model, Optional } from 'sequelize';
import sequelize from '../config/database';

export interface RefreshTokenAttributes {
  id?: number;
  userId: number;
  token: string;
  expiresAt: Date;
  isRevoked: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

interface RefreshTokenCreationAttributes
  extends Optional<RefreshTokenAttributes, 'id' | 'isRevoked'> {}

class RefreshToken
  extends Model<RefreshTokenAttributes, RefreshTokenCreationAttributes>
  implements RefreshTokenAttributes
{
  declare id?: number;
  declare userId: number;
  declare token: string;
  declare expiresAt: Date;
  declare isRevoked: boolean;
  declare readonly createdAt?: Date;
  declare readonly updatedAt?: Date;
}

RefreshToken.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      comment: '用户ID',
    },
    token: {
      type: DataTypes.STRING(500),
      allowNull: false,
      unique: true,
      comment: 'Refresh Token',
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: false,
      comment: '过期时间',
    },
    isRevoked: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      comment: '是否已撤销',
    },
  },
  {
    sequelize,
    tableName: 'refresh_tokens',
    timestamps: true,
    indexes: [
      {
        fields: ['userId'],
      },
      {
        fields: ['token'],
      },
    ],
  },
);

export default RefreshToken;
