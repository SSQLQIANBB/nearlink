import { DataTypes, Model, Optional } from 'sequelize';
import sequelize from '../config/database';

export interface GroupInvitationAttributes {
  id?: number;
  groupId: number;
  inviterId: number;
  inviteeId: number;
  status: 'pending' | 'accepted' | 'rejected';
  createdAt?: Date;
  updatedAt?: Date;
}

interface GroupInvitationCreationAttributes
  extends Optional<GroupInvitationAttributes, 'id' | 'status'> {}

class GroupInvitation
  extends Model<GroupInvitationAttributes, GroupInvitationCreationAttributes>
  implements GroupInvitationAttributes
{
  declare id?: number;
  declare groupId: number;
  declare inviterId: number;
  declare inviteeId: number;
  declare status: 'pending' | 'accepted' | 'rejected';
  declare readonly createdAt?: Date;
  declare readonly updatedAt?: Date;
}

GroupInvitation.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    groupId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      comment: '群组ID',
    },
    inviterId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      comment: '邀请者用户ID',
    },
    inviteeId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      comment: '被邀请者用户ID',
    },
    status: {
      type: DataTypes.ENUM('pending', 'accepted', 'rejected'),
      defaultValue: 'pending',
      comment: '邀请状态',
    },
  },
  {
    sequelize,
    tableName: 'group_invitations',
    timestamps: true,
  },
);

export default GroupInvitation;
