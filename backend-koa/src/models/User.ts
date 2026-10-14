import { DataTypes, Model } from 'sequelize';
import { randomUUID } from 'crypto';
import sequelize from '../config/database';

export interface UserAttributes {
  id?: number;
  username: string;
  password: string;
  authVersion?: string;
  nickname?: string;
  avatar?: string;
  email?: string;
  phone?: string;
  bio?: string;
  status?: 'online' | 'offline' | 'busy';
  lastLoginAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

class User extends Model<UserAttributes> implements UserAttributes {
  declare id: number;
  declare username: string;
  declare password: string;
  declare authVersion: string;
  declare nickname?: string;
  declare avatar?: string;
  declare email?: string;
  declare phone?: string;
  declare bio?: string;
  declare status?: 'online' | 'offline' | 'busy';
  declare lastLoginAt?: Date;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;
}

User.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    username: {
      type: DataTypes.STRING(50),
      allowNull: false,
      unique: true,
    },
    password: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    authVersion: {
      type: DataTypes.UUID,
      allowNull: false,
      defaultValue: () => randomUUID(),
    },
    nickname: {
      type: DataTypes.STRING(50),
      allowNull: true,
    },
    avatar: {
      type: DataTypes.STRING(500),
      allowNull: true,
    },
    email: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    phone: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    bio: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    status: {
      type: DataTypes.ENUM('online', 'offline', 'busy'),
      defaultValue: 'offline',
    },
    lastLoginAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'users',
    timestamps: true,
  },
);

export default User;
