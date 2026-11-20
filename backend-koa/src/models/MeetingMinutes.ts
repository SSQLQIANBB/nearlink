import { DataTypes, Model, type InferAttributes, type InferCreationAttributes, type CreationOptional } from 'sequelize';
import sequelize from '../config/database';

/**
 * 会议记录（实时录音转写 + AI 纪要）。
 *
 * 生命周期拆分为两个独立状态，不用 finalized 同时表达录音结束与纪要完成：
 * - recordingStatus（status 列）：录音结束即 ended/failed，不再变化；
 * - summaryStatus（summaryStatus 列）：纪要生成独立维护，失败保留上一份成功纪要。
 */
export class MeetingMinutes extends Model<
  InferAttributes<MeetingMinutes>,
  InferCreationAttributes<MeetingMinutes>
> {
  declare sessionId: string;
  declare userId: number;
  declare title: string;
  /** 来源：offline（独立线下录制）/ call（通话中录制，P2）。 */
  declare source: 'offline' | 'call';
  /** 录音状态：recording/paused/finalizing/ended/failed（结束即定终态）。 */
  declare status: 'recording' | 'paused' | 'finalizing' | 'ended' | 'failed';
  declare sourceLanguage: string;
  declare targetLanguage: string;
  /** 累计录音秒数（服务端按去重后实际接收样本累计）。 */
  declare durationSeconds: number;
  /** 完整转写文本（确认句）。 */
  declare transcript: string;
  /** 转写结构（segmentId/时间戳/说话人）。 */
  declare transcriptJson: string;
  /** AI 纪要（Markdown）。 */
  declare summary: string;
  /** 要点提取（JSON 数组字符串）。 */
  declare keyPoints: string;
  /** 思维导图（markmind JSON 字符串）。 */
  declare mindmap: string;
  /** 纪要状态：idle/generating/ready/failed（与录音状态独立）。 */
  declare summaryStatus: 'idle' | 'generating' | 'ready' | 'failed';
  /** 纪要最近一次生成失败原因（SummaryError.type）。 */
  declare summaryError: string;
  declare endedAt: CreationOptional<Date | null>;
  declare endReason: CreationOptional<string | null>;
  /**
   * 音频状态（与录音状态、纪要状态独立）：
   * recording 写入中 / pending 停止采集待保存（含重启续传）/ uploading 上传中 /
   * ready 已上传七牛私有空间 / partial 尾片不完整按已有保存 / failed 保存失败 /
   * missing 无音频（旧版本历史数据）。
   */
  declare audioStatus: 'recording' | 'pending' | 'uploading' | 'ready' | 'partial' | 'failed' | 'missing' | 'deleting';
  /** 稳定七牛对象引用（qiniu://private/<key>）；不保存短期签名 URL。 */
  declare audioStorageRef: CreationOptional<string | null>;
  /** 音频保存失败原因（错误类别，非完整堆栈）。 */
  declare audioError: CreationOptional<string | null>;
  /** 暂停/断线后的恢复截止时间（手动暂停 3 小时，普通断线 5 分钟）。 */
  declare audioPausedAttachDeadline: CreationOptional<Date | null>;
  declare audioSize: CreationOptional<number | null>;
  declare audioRetryCount: CreationOptional<number>;
  declare audioRetryAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
MeetingMinutes.init(
  {
    sessionId: { type: DataTypes.UUID, primaryKey: true },
    userId: { type: DataTypes.INTEGER, allowNull: false },
    title: { type: DataTypes.STRING(120), allowNull: false, defaultValue: '' },
    source: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'offline' },
    status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'recording' },
    sourceLanguage: { type: DataTypes.STRING(16), allowNull: false, defaultValue: '中文' },
    targetLanguage: { type: DataTypes.STRING(16), allowNull: false, defaultValue: '英语' },
    durationSeconds: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    transcript: { type: DataTypes.TEXT('long'), allowNull: false },
    transcriptJson: { type: DataTypes.TEXT('long'), allowNull: false },
    summary: { type: DataTypes.TEXT('long'), allowNull: true },
    keyPoints: { type: DataTypes.TEXT, allowNull: true },
    mindmap: { type: DataTypes.TEXT('long'), allowNull: true },
    summaryStatus: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'idle' },
    summaryError: { type: DataTypes.STRING(64), allowNull: true, defaultValue: null },
    endedAt: { type: DataTypes.DATE, allowNull: true, defaultValue: null },
    endReason: { type: DataTypes.STRING(32), allowNull: true, defaultValue: null },
    audioStatus: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'recording' },
    audioStorageRef: { type: DataTypes.STRING(255), allowNull: true, defaultValue: null },
    audioError: { type: DataTypes.STRING(64), allowNull: true, defaultValue: null },
    audioPausedAttachDeadline: { type: DataTypes.DATE, allowNull: true, defaultValue: null },
    audioSize: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true, defaultValue: null },
    audioRetryCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    audioRetryAt: { type: DataTypes.DATE, allowNull: true, defaultValue: null },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'meeting_minutes',
    timestamps: true,
    indexes: [{ fields: ['userId', 'createdAt'] }, { fields: ['status'] }],
  },
);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 查询/修改前统一校验 sessionId 格式，避免无效 SQL。 */
export function isValidSessionId(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}
