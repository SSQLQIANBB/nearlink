<template>
  <DesktopReleaseCenter
    v-if="content.kind === 'release'"
    standalone
  />
  <AvatarCropper
    v-else-if="content.kind === 'avatar' && avatar"
    :file="avatar"
    standalone
    :upload-file="uploadAvatar"
    @cancel="finishDialog()"
    @uploaded="finishDialog($event)"
  />
  <DesktopScreenPicker
    v-else-if="content.kind === 'screen-picker'"
    standalone
    :request="screenRequest"
    @select="finishDialog($event)"
    @cancel="finishDialog()"
  />
  <section
    v-else
    class="desktop-dialog-content"
  >
    <h1>{{ content.title }}</h1>
    <n-alert
      v-if="error"
      type="error"
      class="mb-4"
      closable
      @close="error = ''"
    >
      {{ error }}
    </n-alert>
    <template v-if="content.kind === 'confirm'">
      <p class="dialog-description">{{ data.content }}</p>
      <div class="desktop-dialog-actions">
        <n-button
          v-if="data.negativeText"
          :disabled="busy"
          @click="confirm('negative')"
        >
          {{ data.negativeText }}
        </n-button>
        <n-button
          v-if="data.positiveText"
          type="primary"
          :loading="busy"
          @click="confirm('positive')"
        >
          {{ data.positiveText }}
        </n-button>
      </div>
    </template>
    <template v-else-if="content.kind === 'group-create' || content.kind === 'group-edit'">
      <n-form
        ref="formRef"
        :model="groupForm"
        :rules="groupRules"
      >
        <n-form-item
          label="群组名称"
          path="name"
        >
          <n-input
            v-model:value="groupForm.name"
            maxlength="50"
            show-count
            placeholder="请输入群组名称"
          />
        </n-form-item>
        <n-form-item label="群组简介">
          <n-input
            v-model:value="groupForm.description"
            type="textarea"
            maxlength="200"
            show-count
            :rows="4"
            placeholder="介绍一下您的群组"
          />
        </n-form-item>
      </n-form>
      <div class="desktop-dialog-actions">
        <n-button
          :disabled="busy"
          @click="finishDialog()"
        >
          取消
        </n-button>
        <n-button
          type="primary"
          :loading="busy"
          @click="saveGroup"
        >
          {{ content.kind === 'group-create' ? '立即创建' : '保存' }}
        </n-button>
      </div>
    </template>
    <template v-else-if="content.kind === 'group-detail'">
      <n-spin :show="busy">
        <n-tabs
          v-if="detail"
          type="line"
        >
          <n-tab-pane
            name="info"
            tab="群组信息"
          >
            <div class="dialog-group-summary">
              <n-avatar
                :size="64"
                :src="detail.group.avatar || undefined"
              >
                {{ detail.group.name.charAt(0) }}
              </n-avatar>
              <div>
                <h2>{{ detail.group.name }}</h2>
                <p>{{ detail.group.description }}</p>
              </div>
            </div>
            <n-descriptions
              :column="1"
              label-placement="left"
            >
              <n-descriptions-item label="群组 ID">{{ detail.group.id }}</n-descriptions-item>
              <n-descriptions-item label="成员数量">
                {{ detail.members.length }}
              </n-descriptions-item>
              <n-descriptions-item label="我的角色">
                {{ roleLabel(detail.myRole) }}
              </n-descriptions-item>
            </n-descriptions>
          </n-tab-pane>
          <n-tab-pane
            name="members"
            :tab="`成员管理 (${detail.members.length})`"
          >
            <n-button
              v-if="detail.myRole === 'owner' || detail.myRole === 'admin'"
              type="primary"
              size="small"
              @click="invite"
            >
              邀请成员
            </n-button>
            <div
              v-for="member in detail.members"
              :key="member.id"
              class="dialog-person"
            >
              <n-avatar
                :size="36"
                :src="member.avatar || undefined"
              >
                {{ (member.nickname || member.username).charAt(0) }}
              </n-avatar>
              <span class="dialog-person-name">
                {{ member.nickname || member.username }}
                <small>{{ roleLabel(member.role) }}</small>
              </span>
              <n-switch
                v-if="detail.myRole === 'owner' && member.role !== 'owner'"
                :value="member.canSpeak"
                :disabled="busy"
                @update:value="permission(member.id, $event)"
              >
                <template #checked>允许发言</template>
                <template #unchecked>已禁言</template>
              </n-switch>
            </div>
          </n-tab-pane>
        </n-tabs>
      </n-spin>
      <div
        v-if="detail?.myRole === 'owner'"
        class="desktop-dialog-actions"
      >
        <n-button
          type="error"
          :disabled="busy"
          @click="deleteGroup"
        >
          删除群组
        </n-button>
      </div>
    </template>
    <template v-else-if="content.kind === 'group-invite' || content.kind === 'forward'">
      <n-input
        v-model:value="search"
        clearable
        :placeholder="content.kind === 'forward' ? '搜索联系人或群聊' : '搜索联系人姓名'"
      />
      <n-spin :show="busy">
        <div class="dialog-recipient-list">
          <label
            v-for="person in filtered"
            :key="person.key"
            class="dialog-person"
          >
            <n-avatar
              :size="36"
              :src="person.avatar || undefined"
            >
              {{ person.name.charAt(0) }}
            </n-avatar>
            <span class="dialog-person-name">
              {{ person.name }}
              <small v-if="person.kind === 'group'">群聊</small>
            </span>
            <input
              v-model="selected"
              type="checkbox"
              :value="person.key"
              :disabled="busy"
            />
          </label>
          <n-empty
            v-if="!busy && !filtered.length"
            description="暂无可选择的会话或联系人"
          />
        </div>
      </n-spin>
      <template v-if="content.kind === 'forward'">
        <div class="dialog-forward-summary">
          <p
            v-for="(item, index) in data.messages"
            :key="index"
          >
            {{ item.message }}
          </p>
        </div>
        <n-input
          v-model:value="note"
          placeholder="留言"
          maxlength="10000"
          :disabled="busy"
        />
      </template>
      <div class="desktop-dialog-actions">
        <n-button
          :disabled="busy"
          @click="finishDialog()"
        >
          取消
        </n-button>
        <n-button
          type="primary"
          :loading="busy"
          :disabled="!selected.length"
          @click="sendRecipients"
        >
          {{ content.kind === 'forward' ? '发送' : '确认邀请' }} ({{ selected.length }})
        </n-button>
      </div>
    </template>
    <template v-else-if="content.kind === 'password'">
      <n-form
        ref="formRef"
        :model="password"
        :rules="passwordRules"
      >
        <n-form-item
          label="当前密码"
          path="oldPassword"
        >
          <n-input
            v-model:value="password.oldPassword"
            type="password"
            placeholder="请输入当前密码"
          />
        </n-form-item>
        <n-form-item
          label="新密码"
          path="newPassword"
        >
          <n-input
            v-model:value="password.newPassword"
            type="password"
            placeholder="至少 6 位，包含大小写字母和数字"
          />
        </n-form-item>
        <n-form-item
          label="确认密码"
          path="confirmPassword"
        >
          <n-input
            v-model:value="password.confirmPassword"
            type="password"
            placeholder="请再次输入新密码"
          />
        </n-form-item>
        <n-form-item
          label="邮箱验证码"
          path="emailCode"
        >
          <div class="dialog-code">
            <n-input
              v-model:value="password.emailCode"
              maxlength="6"
              placeholder="6 位验证码"
            />
            <n-button
              :disabled="!data.email || cooldown > 0 || busy"
              @click="sendCode"
            >
              {{ cooldown ? `${cooldown}s 后重发` : '发送验证码' }}
            </n-button>
          </div>
        </n-form-item>
      </n-form>
      <p v-if="!data.email">请先在账户安全中绑定并验证邮箱。</p>
      <div class="desktop-dialog-actions">
        <n-button
          :disabled="busy"
          @click="finishDialog()"
        >
          取消
        </n-button>
        <n-button
          type="primary"
          :loading="busy"
          @click="savePassword"
        >
          确认修改
        </n-button>
      </div>
    </template>
    <template v-else-if="content.kind === 'recording'">
      <p>录制时长：{{ data.duration }} · 文件大小：{{ data.size }}</p>
      <video
        :src="data.url"
        controls
        class="dialog-recording"
      />
      <n-input
        v-model:value="filename"
        placeholder="请输入文件名"
      >
        <template #suffix>.{{ data.extension }}</template>
      </n-input>
      <div class="desktop-dialog-actions">
        <n-button
          :disabled="busy"
          @click="finishDialog('discard')"
        >
          丢弃
        </n-button>
        <n-button
          type="primary"
          :loading="busy"
          @click="saveRecording"
        >
          保存
        </n-button>
      </div>
    </template>
    <template v-else-if="content.kind === 'annotation'">
      <n-input
        v-model:value="text"
        type="textarea"
        placeholder="请输入文字…"
        :rows="5"
        maxlength="2000"
      />
      <div class="desktop-dialog-actions">
        <n-button @click="finishDialog()">取消</n-button>
        <n-button
          type="primary"
          @click="finishDialog(text)"
        >
          确定
        </n-button>
      </div>
    </template>
  </section>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useDialog, type FormInst, type FormRules } from 'naive-ui';
import {
  dialogContent,
  dialogBusy as busy,
  dialogAction as action,
  finishDialog,
} from '@/services/desktopDialogClient';
import DesktopReleaseCenter from './DesktopReleaseCenter.vue';
import AvatarCropper from './AvatarCropper.vue';
import DesktopScreenPicker from './DesktopScreenPicker.vue';
import { isValidNewPassword, PASSWORD_RULE_MESSAGE } from '@/utils/passwordPolicy';
import type { GroupDetail } from '@/api/group';
const content = dialogContent.value!;
const data = content.data || {};
const error = ref('');
const formRef = ref<FormInst | null>(null);
const groupForm = ref({ name: data.name || '', description: data.description || '' });
const groupRules: FormRules = {
  name: [{ required: true, min: 2, max: 50, message: '群组名称长度在2-50个字符', trigger: 'blur' }],
};
const detail = ref<GroupDetail>();
type Person = { key: string; id: number; name: string; avatar?: string; kind?: string };
const people = ref<Person[]>([]),
  search = ref(''),
  selected = ref<string[]>([]),
  note = ref('');
const filtered = computed(() =>
  people.value.filter((p) =>
    p.name.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()),
  ),
);
const password = ref({ oldPassword: '', newPassword: '', confirmPassword: '', emailCode: '' });
const passwordRules: FormRules = {
  oldPassword: [{ required: true, message: '请输入当前密码', trigger: 'blur' }],
  newPassword: [
    {
      validator: (_, value) => isValidNewPassword(value),
      message: PASSWORD_RULE_MESSAGE,
      trigger: 'blur',
    },
  ],
  confirmPassword: [
    {
      validator: (_, value) => !!value && value === password.value.newPassword,
      message: '两次输入的密码不一致',
      trigger: 'blur',
    },
  ],
  emailCode: [
    { required: true, pattern: /^\d{6}$/, message: '请输入 6 位邮箱验证码', trigger: 'blur' },
  ],
};
const cooldown = ref(data.cooldown || 0);
const timer = setInterval(() => {
  if (cooldown.value > 0) cooldown.value--;
}, 1000);
onBeforeUnmount(() => clearInterval(timer));
const avatar = ref<File>();
const filename = ref(data.filename || ''),
  text = ref('');
const dialog = useDialog();
const roleLabel = (role: string) =>
  ({ owner: '群主', admin: '管理员', member: '成员' })[role] || '成员';
async function run(task: () => Promise<unknown>) {
  error.value = '';
  try {
    await task();
  } catch (reason) {
    if (reason instanceof Error) error.value = reason.message;
  }
}
async function confirm(name: string) {
  await run(async () => {
    if ((await action(name)) !== false) finishDialog(name);
  });
}
async function saveGroup() {
  await run(async () => {
    await formRef.value!.validate();
    await action('save', groupForm.value);
    finishDialog(true);
  });
}
async function refreshDetail() {
  detail.value = await action('detail');
}
async function invite() {
  await run(async () => {
    await action('invite');
    await refreshDetail();
  });
}
async function permission(id: number, canSpeak: boolean) {
  await run(async () => {
    await action('permission', { id, canSpeak });
    await refreshDetail();
  });
}
function deleteGroup() {
  dialog.warning({
    title: '确认删除群组？',
    content: '删除群组后，群消息历史、成员关系和邀请记录将被永久删除，且无法恢复。',
    positiveText: '确认删除',
    negativeText: '取消',
    positiveButtonProps: { type: 'error' },
    onPositiveClick: async () => {
      try {
        await action('delete');
        finishDialog(true);
      } catch (reason) {
        error.value = String(reason);
        return false;
      }
    },
  });
}
async function sendRecipients() {
  await run(async () => {
    await action('send', { selected: selected.value, note: note.value });
    finishDialog(true);
  });
}
async function sendCode() {
  await run(async () => {
    cooldown.value = await action('code');
  });
}
async function savePassword() {
  await run(async () => {
    await formRef.value!.validate();
    await action('save', password.value);
    finishDialog(true);
  });
}
async function saveRecording() {
  await run(async () => {
    if (await action('save', filename.value)) finishDialog('saved');
  });
}
async function uploadAvatar(form: FormData) {
  const file = form.get('file') as File;
  const bytes = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  return action('upload', bytes);
}
const screenRequest = <T,>(name: string, args?: Record<string, unknown>) => action<T>(name, args);
onMounted(
  () =>
    void run(async () => {
      if (content.kind === 'group-detail') await refreshDetail();
      else if (content.kind === 'group-invite' || content.kind === 'forward')
        people.value = await action('people');
      else if (content.kind === 'avatar') {
        const blob = await (await fetch(data.url)).blob();
        avatar.value = new File([blob], 'avatar', { type: blob.type });
      }
    }),
);
</script>
<style scoped>
.dialog-description {
  margin: 0;
  color: #475569;
  line-height: 1.8;
  white-space: pre-wrap;
}
.dialog-group-summary,
.dialog-person {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 0;
}
.dialog-group-summary {
  margin-bottom: 20px;
}
.dialog-group-summary h2 {
  font-size: 18px;
  margin: 0;
}
.dialog-group-summary p,
.dialog-person small {
  color: #64748b;
}
.dialog-person-name {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.dialog-person small {
  display: block;
  font-size: 12px;
}
.dialog-person + .dialog-person {
  border-top: 1px solid #f1f5f9;
}
label.dialog-person {
  padding: 10px 12px;
  border-radius: 8px;
  cursor: pointer;
}
label.dialog-person:hover,
label.dialog-person:has(input:checked) {
  background: #eff6ff;
}
.dialog-person input[type='checkbox'] {
  width: 16px;
  height: 16px;
  accent-color: #2563eb;
}
.dialog-recipient-list {
  max-height: 320px;
  overflow: auto;
  margin: 16px 0;
}
.dialog-forward-summary {
  max-height: 130px;
  overflow: auto;
  background: #f8fafc;
  padding: 12px;
  margin-bottom: 16px;
  border-radius: 10px;
}
.dialog-forward-summary p {
  margin: 4px 0;
  overflow-wrap: anywhere;
}
.dialog-code {
  display: flex;
  gap: 8px;
  width: 100%;
}
.dialog-recording {
  display: block;
  width: 100%;
  max-height: 320px;
  margin: 16px 0;
  background: #0f172a;
}
</style>
