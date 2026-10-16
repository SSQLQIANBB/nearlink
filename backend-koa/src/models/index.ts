import './MessageDeletion';
import User from './User';
import Group from './Group';
import GroupMember from './GroupMember';
import Message from './Message';
import GroupMessage from './GroupMessage';
import UserEmail from './UserEmail';
import UserNotificationSettings from './UserNotificationSettings';
import MessageReceipt from './MessageReceipt';
import GroupInvitation from './GroupInvitation';
import RefreshToken from './RefreshToken';
import LoginSession from './LoginSession';
import File from './File';

// 定义模型关联关系
UserNotificationSettings.belongsTo(User, { foreignKey: 'userId', onDelete: 'CASCADE' });

// User 和 Group 的所有者关系
User.hasMany(Group, { foreignKey: 'ownerId', as: 'ownedGroups' });
Group.belongsTo(User, { foreignKey: 'ownerId', as: 'owner' });

// Group 和 User 的多对多关系（通过 GroupMember）
Group.belongsToMany(User, { through: GroupMember, foreignKey: 'groupId', as: 'members' });
User.belongsToMany(Group, { through: GroupMember, foreignKey: 'userId', as: 'groups' });

// GroupMember 和 Group 的关系（用于 include 查询）
GroupMember.belongsTo(Group, { foreignKey: 'groupId', as: 'group' });
Group.hasMany(GroupMember, { foreignKey: 'groupId', as: 'groupMembers' });

// GroupMember 和 User 的关系（用于 include 查询）
GroupMember.belongsTo(User, { foreignKey: 'userId', as: 'user' });
User.hasMany(GroupMember, { foreignKey: 'userId', as: 'memberships' });

// Message 和 User 的关系
Message.belongsTo(User, { foreignKey: 'fromUserId', as: 'sender' });
Message.belongsTo(User, { foreignKey: 'toUserId', as: 'receiver' });
User.hasMany(Message, { foreignKey: 'fromUserId', as: 'sentMessages' });
User.hasMany(Message, { foreignKey: 'toUserId', as: 'receivedMessages' });

// GroupInvitation 和 User、Group 的关系
GroupInvitation.belongsTo(Group, { foreignKey: 'groupId', as: 'group' });
GroupInvitation.belongsTo(User, { foreignKey: 'inviterId', as: 'inviter' });
GroupInvitation.belongsTo(User, { foreignKey: 'inviteeId', as: 'invitee' });
Group.hasMany(GroupInvitation, { foreignKey: 'groupId', as: 'invitations' });
User.hasMany(GroupInvitation, { foreignKey: 'inviterId', as: 'sentInvitations' });
User.hasMany(GroupInvitation, { foreignKey: 'inviteeId', as: 'receivedInvitations' });

LoginSession.belongsTo(User, { foreignKey: 'userId', as: 'user', onDelete: 'CASCADE' });
User.hasMany(LoginSession, { foreignKey: 'userId', as: 'loginSessions' });

// RefreshToken 和 User 的关系
RefreshToken.belongsTo(User, { foreignKey: 'userId', as: 'user' });
User.hasMany(RefreshToken, { foreignKey: 'userId', as: 'refreshTokens' });

// GroupMessage 和 User、Group 的关系
GroupMessage.belongsTo(User, { foreignKey: 'userId', as: 'sender' });
GroupMessage.belongsTo(Group, { foreignKey: 'groupId', as: 'group' });
User.hasMany(GroupMessage, { foreignKey: 'userId', as: 'groupMessages' });
Group.hasMany(GroupMessage, { foreignKey: 'groupId', as: 'messages' });

// File 和 User、Group 的关系
File.belongsTo(User, { foreignKey: 'userId', as: 'uploader' });
File.belongsTo(Group, { foreignKey: 'groupId', as: 'group' });
User.hasMany(File, { foreignKey: 'userId', as: 'files' });
Group.hasMany(File, { foreignKey: 'groupId', as: 'files' });

export {
  User,
  UserEmail,
  MessageReceipt,
  Group,
  GroupMember,
  Message,
  GroupMessage,
  GroupInvitation,
  RefreshToken,
  File,
};

export { LoginSession };
export {
  RemoteDevice,
  AssistanceGrant,
  RemoteSessionRecord,
  RemoteSessionEvent,
} from './RemoteControl';
