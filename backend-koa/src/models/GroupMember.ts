import { DataTypes, Model } from 'sequelize';
import sequelize from '../config/database';

export interface GroupMemberAttributes {
  id?: number;
  groupId: number;
  userId: number;
  role?: 'owner' | 'admin' | 'member';
  canSpeak?: boolean; // 是否可以发言
  joinedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

class GroupMember extends Model<GroupMemberAttributes> implements GroupMemberAttributes {
  declare id: number;
  declare groupId: number;
  declare userId: number;
  declare role?: 'owner' | 'admin' | 'member';
  declare canSpeak?: boolean;
  declare joinedAt?: Date;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;
}

GroupMember.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    groupId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    role: {
      type: DataTypes.ENUM('owner', 'admin', 'member'),
      defaultValue: 'member',
    },
    canSpeak: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    joinedAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    sequelize,
    tableName: 'group_members',
    timestamps: true,
  },
);

export default GroupMember;
