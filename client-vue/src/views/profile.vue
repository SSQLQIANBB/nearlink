<template>
  <div class="profile-page min-h-screen bg-slate-50 p-3 sm:p-6 overflow-x-hidden">
    <div class="max-w-4xl mx-auto">
      <!-- 页面头部 -->
      <div class="flex flex-wrap items-center justify-between gap-3 mb-4 sm:mb-6">
        <div>
          <h1 class="text-2xl sm:text-3xl font-bold text-gray-800">个人中心</h1>
          <p class="text-gray-500 mt-1">管理您的个人信息</p>
          <p class="mt-1 text-xs text-slate-500">NearLink {{ APP_VERSION_LABEL }}</p>
        </div>
        <n-button @click="goBack" secondary>
          <template #icon>
            <n-icon><i class="iconfont icon-arrow-left" aria-hidden="true"></i></n-icon>
          </template>
          返回
        </n-button>
      </div>

      <!-- 用户信息卡片 -->
      <n-card class="profile-card">
        <n-tabs type="line" animated>
          <!-- 基本信息 -->
          <n-tab-pane name="basic" tab="基本信息">
            <n-form ref="formRef" :model="formData" :rules="rules" label-placement="top" label-width="100">
              <!-- 头像 -->
              <n-form-item :show-label="false">
                <div class="flex items-center gap-4">
                  <n-avatar 
                    :size="80" 
                    :src="formData.avatar"
                    class="shadow-md flex-shrink-0"
                  >
                    <span v-if="!formData.avatar">{{ formData.nickname?.charAt(0) || formData.username?.charAt(0) || '?' }}</span>
                  </n-avatar>
                  <div class="flex flex-col gap-2">
                    <input ref="avatarInput" type="file" accept="image/jpeg,image/png" hidden @change="selectAvatar" />
                    <n-button size="small" secondary @click="avatarInput?.click()">上传头像</n-button>
                    <p class="text-xs text-gray-500">支持 JPG、PNG 格式，最大 20MB</p>
                  </div>
                </div>
              </n-form-item>

              <!-- 用户名 -->
              <n-form-item label="用户名">
                <n-input 
                  v-model:value="formData.username" 
                  disabled
                  placeholder="用户名不可修改"
                />
              </n-form-item>

              <!-- 昵称 -->
              <n-form-item label="昵称" path="nickname">
                <n-input 
                  v-model:value="formData.nickname" 
                  placeholder="请输入昵称"
                  maxlength="50"
                  show-count
                />
              </n-form-item>

              <!-- 邮箱 -->
              <n-form-item label="已验证邮箱">
                <n-input
                  v-model:value="formData.email"
                  placeholder="尚未绑定邮箱，请到账户安全中绑定"
                  type="email"
                  disabled
                />
              </n-form-item>

              <!-- 手机号 -->
              <n-form-item label="手机号" path="phone">
                <n-input 
                  v-model:value="formData.phone" 
                  placeholder="请输入手机号"
                  maxlength="20"
                />
              </n-form-item>

              <!-- 个人简介 -->
              <n-form-item label="个人简介">
                <n-input
                  v-model:value="formData.bio"
                  type="textarea"
                  placeholder="介绍一下自己吧..."
                  :rows="4"
                  maxlength="200"
                  show-count
                />
              </n-form-item>

              <!-- 操作按钮 -->
              <n-form-item>
                <div class="w-full flex gap-3 justify-center">
                  <n-button 
                    type="primary" 
                    :loading="loading"
                    @click="handleSubmit"
                  >
                    保存修改
                  </n-button>
                  <n-button @click="handleReset">
                    重置
                  </n-button>
                </div>
              </n-form-item>
            </n-form>
          </n-tab-pane>

          <!-- 账户安全 -->
          <n-tab-pane name="security" tab="账户安全">
            <div class="space-y-6">
              <div class="p-4 bg-gray-50 rounded-lg">
                <h3 class="font-semibold text-gray-800">邮箱绑定</h3>
                <p v-if="verifiedEmail" class="text-sm text-green-700 mt-1">已验证：{{ verifiedEmail }}</p>
                <div v-else class="mt-3 space-y-3">
                  <p class="text-sm text-gray-500">绑定并验证邮箱后，可找回或修改密码。</p>
                  <n-input v-model:value="bindEmailForm.email" type="email" placeholder="请输入邮箱" />
                  <div class="flex flex-wrap gap-2">
                    <n-input v-model:value="bindEmailForm.code" maxlength="6" placeholder="6 位验证码" class="min-w-[120px] flex-1" />
                    <n-button :loading="emailCodeLoading" :disabled="bindCooldown > 0" class="w-28 shrink-0 tabular-nums" @click="sendBindEmailCode">{{ bindCooldown > 0 ? `${bindCooldown}s 后重发` : '发送验证码' }}</n-button>
                    <n-button type="primary" :loading="bindLoading" @click="handleBindEmail">绑定邮箱</n-button>
                  </div>
                </div>
              </div>
              <!-- 修改密码 -->
              <div class="p-4 bg-gray-50 rounded-lg">
                <div class="flex items-center justify-between">
                  <div>
                    <h3 class="font-semibold text-gray-800">修改密码</h3>
                    <p class="text-sm text-gray-500 mt-1">定期修改密码，保护账户安全</p>
                  </div>
                  <n-button type="primary" secondary @click="showPasswordModal = true">
                    修改密码
                  </n-button>
                </div>
              </div>

              <!-- 账户状态 -->
              <div class="p-4 bg-gray-50 rounded-lg">
                <div class="flex items-center justify-between">
                  <div>
                    <h3 class="font-semibold text-gray-800">账户状态</h3>
                    <p class="text-sm text-gray-500 mt-1">
                      当前状态：<n-tag :type="statusColor" size="small">{{ statusText }}</n-tag>
                    </p>
                  </div>
                  <n-select
                    v-model:value="formData.status"
                    :options="statusOptions"
                    style="width: 120px"
                    @update:value="handleStatusChange"
                  />
                </div>
              </div>

              <!-- 最后登录 -->
              <div class="p-4 bg-gray-50 rounded-lg">
                <h3 class="font-semibold text-gray-800">登录信息</h3>
                <p class="text-sm text-gray-500 mt-2">
                  最后登录时间：{{ lastLoginTime }}
                </p>
              </div>
            </div>
          </n-tab-pane>

          <!-- 通知设置 -->
          <n-tab-pane name="notification" tab="通知设置">
            <div v-if="desktop" class="mb-4 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-800">
              关闭窗口后 NearLink 会留在系统托盘，继续接收消息和通话。点击托盘图标可返回，右键选择“退出 NearLink”可结束应用。
              系统通知由 Windows 通知设置控制；收到通知后可从托盘回到聊天。
            </div>
            <p v-if="notificationSettings.error" role="alert" class="text-red-600 mb-4">
              {{ notificationSettings.error }}
              <n-button v-if="notificationSettings.status === 'error'" text type="primary" @click="notificationSettings.load(authStore.currentUser!.id)">重试</n-button>
            </p>
            <p v-if="notificationSettings.status === 'loading'" class="text-gray-500 mb-4">正在加载通知设置…</p>
            <div class="space-y-6">
              <!-- 桌面通知 -->
              <div class="p-4 bg-gray-50 rounded-lg">
                <div class="flex items-center justify-between">
                  <div>
                    <h3 class="font-semibold text-gray-800">桌面通知</h3>
                    <p class="text-sm text-gray-500 mt-1">
                      <span v-if="notificationPermission === 'granted' && notificationEnabled" class="text-green-600">✓ 已启用</span>
                      <span v-else-if="notificationPermission === 'granted'" class="text-gray-500">已关闭</span>
                      <span v-else-if="notificationPermission === 'denied'" class="text-red-600">✗ 已拒绝</span>
                      <span v-else class="text-yellow-600">⚠ 未请求</span>
                      - 接收新消息、通话等桌面通知
                    </p>
                  </div>
                  <div class="flex items-center gap-2">
                    <n-switch 
                      :value="notificationEnabled" :loading="notificationSettings.status === 'saving'"
                      @update:value="notificationSettings.save({ desktopEnabled: $event })"
                      :disabled="notificationSettings.disabled"
                    />
                    <n-button 
                      v-if="notificationPermission !== 'granted'" 
                      size="small" 
                      type="primary"
                      :disabled="notificationSettings.disabled"
                      @click="requestNotificationPermission"
                    >
                      请求权限
                    </n-button>
                  </div>
                </div>
              </div>

              <NotificationSoundSettings :settings="notificationSettings.settings" :disabled="notificationSettings.disabled" @update="notificationSettings.save" />

              <!-- 消息预览 -->
              <div class="p-4 bg-gray-50 rounded-lg">
                <div class="flex items-center justify-between">
                  <div>
                    <h3 class="font-semibold text-gray-800">消息预览</h3>
                    <p class="text-sm text-gray-500 mt-1">在通知中显示消息内容</p>
                  </div>
                  <n-switch :value="notificationSettings.settings.messagePreview" :disabled="notificationSettings.disabled" aria-label="消息预览" @update:value="notificationSettings.save({ messagePreview: $event })" />
                </div>
              </div>

              <!-- 通知类型设置 -->
              <div class="p-4 bg-gray-50 rounded-lg">
                <h3 class="font-semibold text-gray-800">通知类型</h3>
                <p class="text-xs text-gray-500 mt-1 mb-3">控制消息横幅、桌面通知和声音；来电与邀请的操作弹窗仍会显示。</p>
                <div class="space-y-3">
                  <div class="flex items-center justify-between">
                    <span class="text-sm">私聊消息</span>
                    <n-switch :value="notificationSettings.settings.notifyPrivateMessage" :disabled="notificationSettings.disabled" aria-label="私聊消息" @update:value="notificationSettings.save({ notifyPrivateMessage: $event })" />
                  </div>
                  <div class="flex items-center justify-between">
                    <span class="text-sm">群组消息</span>
                    <n-switch :value="notificationSettings.settings.notifyGroupMessage" :disabled="notificationSettings.disabled" aria-label="群组消息" @update:value="notificationSettings.save({ notifyGroupMessage: $event })" />
                  </div>
                  <div class="flex items-center justify-between">
                    <span class="text-sm">来电通知</span>
                    <n-switch :value="notificationSettings.settings.notifyCall" :disabled="notificationSettings.disabled" aria-label="来电通知" @update:value="notificationSettings.save({ notifyCall: $event })" />
                  </div>
                  <div class="flex items-center justify-between">
                    <span class="text-sm">群组邀请</span>
                    <n-switch :value="notificationSettings.settings.notifyInvitation" :disabled="notificationSettings.disabled" aria-label="群组邀请" @update:value="notificationSettings.save({ notifyInvitation: $event })" />
                  </div>
                </div>
              </div>

              <!-- 测试通知 -->
              <div class="p-4 bg-blue-50 rounded-lg border border-blue-200">
                <div class="flex items-center justify-between">
                  <div>
                    <h3 class="font-semibold text-blue-800">测试通知</h3>
                    <p class="text-sm text-blue-600 mt-1">发送一条测试通知，检查设置是否生效</p>
                  </div>
                  <n-button 
                    type="info" 
                    @click="sendTestNotification"
                    :disabled="!notificationEnabled || notificationPermission !== 'granted'"
                  >
                    发送测试
                  </n-button>
                </div>
              </div>
            </div>
          </n-tab-pane>
          <n-tab-pane name="remote-devices" tab="远程设备">
            <RemoteDeviceSettings />
          </n-tab-pane>
        </n-tabs>
      </n-card>

      <AvatarCropper v-if="avatarFile" :file="avatarFile" @cancel="avatarFile = null" @uploaded="avatarUploaded" />

      <!-- 修改密码弹窗 -->
      <n-modal v-model:show="showPasswordModal" preset="card" title="修改密码" style="width: min(500px, calc(100vw - 24px))">
        <n-form ref="passwordFormRef" :model="passwordForm" :rules="passwordRules">
          <n-form-item label="当前密码" path="oldPassword">
            <n-input 
              v-model:value="passwordForm.oldPassword" 
              type="password"
              placeholder="请输入当前密码"
            />
          </n-form-item>
          <n-form-item label="新密码" path="newPassword">
            <n-input 
              v-model:value="passwordForm.newPassword" 
              type="password"
              placeholder="至少 6 位，包含大小写字母和数字"
            />
          </n-form-item>
          <n-form-item label="确认密码" path="confirmPassword">
            <n-input 
              v-model:value="passwordForm.confirmPassword" 
              type="password"
              placeholder="请再次输入新密码"
            />
          </n-form-item>
          <n-form-item label="邮箱验证码" path="emailCode">
            <div class="flex w-full gap-2">
              <n-input v-model:value="passwordForm.emailCode" maxlength="6" placeholder="6 位验证码" class="min-w-0 flex-1" />
              <n-button :disabled="!verifiedEmail || passwordCooldown > 0" :loading="emailCodeLoading" class="w-28 shrink-0 tabular-nums" @click="sendPasswordEmailCode">{{ passwordCooldown > 0 ? `${passwordCooldown}s 后重发` : '发送验证码' }}</n-button>
            </div>
          </n-form-item>
          <p v-if="!verifiedEmail" class="text-sm text-amber-700">请先在账户安全中绑定并验证邮箱。</p>
        </n-form>
        <template #footer>
          <div class="flex justify-end gap-3">
            <n-button @click="showPasswordModal = false">取消</n-button>
            <n-button type="primary" :loading="passwordLoading" @click="handleChangePassword">
              确认修改
            </n-button>
          </div>
        </template>
      </n-modal>
    </div>
  </div>
</template>

<script setup lang="ts">
import { APP_VERSION_LABEL } from '@/config/appVersion';
import { ref, reactive, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useMessage, type FormInst, type FormRules } from 'naive-ui';
import { bindEmail, changePassword, getCurrentUser, getVerifiedEmail, sendEmailCode, updateUser } from '@/api/auth';
import { useAuthStore } from '@/stores/auth';
import { useSocketStore } from '@/stores/socket';
import notificationService from '@/services/notificationService';
import NotificationSoundSettings from '@/components/NotificationSoundSettings.vue';
import AvatarCropper from '@/components/AvatarCropper.vue';
import RemoteDeviceSettings from '@/components/RemoteDeviceSettings.vue';
import { useNotificationSettingsStore } from '@/stores/notificationSettings';
import { useEmailCodeCooldown } from '@/hooks/useEmailCodeCooldown';
import { isValidNewPassword, PASSWORD_RULE_MESSAGE } from '@/utils/passwordPolicy';
import { isTauri } from '@tauri-apps/api/core';

const desktop = isTauri();
const router = useRouter();
const message = useMessage();
const authStore = useAuthStore();
const socketStore = useSocketStore();

const formRef = ref<FormInst | null>(null);
const passwordFormRef = ref<FormInst | null>(null);
const loading = ref(false);
const passwordLoading = ref(false);
const showPasswordModal = ref(false);
const verifiedEmail = ref<string | null>(null);
const emailCodeLoading = ref(false);
const bindLoading = ref(false);
const bindEmailForm = reactive({ email: '', code: '' });
const emailCodeCooldown = useEmailCodeCooldown();
const bindCooldown = computed(() => emailCodeCooldown.remaining('bind', bindEmailForm.email));
const passwordCooldown = computed(() => emailCodeCooldown.remaining('change-password', verifiedEmail.value || ''));

// 表单数据
const formData = reactive({
  username: '',
  nickname: '',
  email: '',
  phone: '',
  avatar: '',
  bio: '',
  status: 'online' as 'online' | 'offline' | 'busy',
});

// 密码表单
const passwordForm = reactive({
  oldPassword: '',
  newPassword: '',
  confirmPassword: '',
  emailCode: '',
});

// 表单验证规则
const rules: FormRules = {
  nickname: [
    { max: 50, message: '昵称最多50个字符', trigger: 'blur' },
  ],
  email: [
    { type: 'email', message: '请输入正确的邮箱格式', trigger: 'blur' },
  ],
  phone: [
    { pattern: /^1[3-9]\d{9}$/, message: '请输入正确的手机号', trigger: 'blur' },
  ],
};

const passwordRules: FormRules = {
  oldPassword: [
    { required: true, message: '请输入当前密码', trigger: 'blur' },
  ],
  newPassword: [
    { required: true, message: '请输入新密码', trigger: 'blur' },
    { validator: (_rule, value) => isValidNewPassword(value), message: PASSWORD_RULE_MESSAGE, trigger: 'blur' },
  ],
  confirmPassword: [
    { required: true, message: '请再次输入新密码', trigger: 'blur' },
    {
      validator: (_rule, value) => {
        return value === passwordForm.newPassword;
      },
      message: '两次输入的密码不一致',
      trigger: 'blur',
    },
  ],
  emailCode: [{ required: true, pattern: /^\d{6}$/, message: '请输入 6 位邮箱验证码', trigger: 'blur' }],
};

async function sendBindEmailCode() {
  if (emailCodeLoading.value || bindCooldown.value > 0) return;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bindEmailForm.email.trim())) {
    message.error('请输入有效邮箱'); return;
  }
  emailCodeLoading.value = true;
  try {
    const result = await sendEmailCode('bind', bindEmailForm.email);
    emailCodeCooldown.start('bind', bindEmailForm.email);
    message.success(result.message);
  } catch (error: any) { message.error(error.message || '发送失败'); }
  finally { emailCodeLoading.value = false; }
}

async function handleBindEmail() {
  if (bindLoading.value) return;
  bindLoading.value = true;
  try {
    const result = await bindEmail(bindEmailForm.email, bindEmailForm.code);
    verifiedEmail.value = result.email;
    formData.email = result.email;
    authStore.updateUserInfo({ email: result.email });
    bindEmailForm.code = '';
    message.success('邮箱绑定成功');
  } catch (error: any) { message.error(error.message || '绑定失败'); }
  finally { bindLoading.value = false; }
}

async function sendPasswordEmailCode() {
  if (emailCodeLoading.value || passwordCooldown.value > 0) return;
  if (!verifiedEmail.value) { message.error('请先绑定邮箱'); return; }
  emailCodeLoading.value = true;
  try {
    const result = await sendEmailCode('change-password', verifiedEmail.value);
    emailCodeCooldown.start('change-password', verifiedEmail.value);
    message.success(result.message);
  } catch (error: any) { message.error(error.message || '发送失败'); }
  finally { emailCodeLoading.value = false; }
}

// 状态选项
const statusOptions = [
  { label: '在线', value: 'online' },
  { label: '忙碌', value: 'busy' },
  { label: '离线', value: 'offline' },
];

const statusColor = computed(() => {
  const colorMap = {
    online: 'success',
    busy: 'warning',
    offline: 'default',
  };
  return colorMap[formData.status] as any;
});

const statusText = computed(() => {
  const textMap = {
    online: '在线',
    busy: '忙碌',
    offline: '离线',
  };
  return textMap[formData.status];
});

const lastLoginTime = computed(() => {
  // 这里可以从用户数据中获取
  return new Date().toLocaleString();
});

// 偏好随账号保存；浏览器通知权限仍属于当前设备。
const notificationSettings = useNotificationSettingsStore();
const notificationPermission = ref(notificationService.getPermission());
const notificationEnabled = computed(() => notificationSettings.settings.desktopEnabled);

async function requestNotificationPermission() {
  const granted = await notificationService.requestPermission();
  notificationPermission.value = notificationService.getPermission();
  if (granted) {
    await notificationSettings.save({ desktopEnabled: true });
    if (!notificationSettings.error) message.success('通知权限已授予');
  } else message.error('通知权限被拒绝');
}

// 发送测试通知
async function sendTestNotification() {
  const sent = await notificationService.showSystem(
    '测试通知',
    '这是一条测试通知，您的通知设置已生效！'
  );
  if (sent) message.success('测试通知已发送');
  else message.error('测试通知未发送，请检查浏览器通知权限');
}

// 加载用户信息
async function loadUserInfo() {
  try {
    const { user } = await getCurrentUser();
    Object.assign(formData, user);
    verifiedEmail.value = (await getVerifiedEmail()).email;
    formData.email = verifiedEmail.value || '';
  } catch (error: any) {
    message.error('加载用户信息失败: ' + error.message);
  }
}

const avatarInput = ref<HTMLInputElement | null>(null);
const avatarFile = ref<File | null>(null);

function selectAvatar(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (!['image/jpeg', 'image/png'].includes(file.type)) {
    message.error('请选择 JPG 或 PNG 图片');
    return;
  }
  if (file.size > 20 * 1024 * 1024) {
    message.error('图片大小不能超过 20MB');
    return;
  }
  avatarFile.value = file;
}

function avatarUploaded(url: string) {
  formData.avatar = url;
  avatarFile.value = null;
  message.success('头像已裁剪上传，请保存修改');
}

// 提交表单
async function handleSubmit() {
  try {
    await formRef.value?.validate();
    loading.value = true;

    const { user } = await updateUser({
      nickname: formData.nickname,
      phone: formData.phone,
      avatar: formData.avatar,
      bio: formData.bio,
      status: formData.status,
    });

    authStore.updateUserInfo(user);
    message.success('保存成功');
  } catch (error: any) {
    if (error.message) {
      message.error('保存失败: ' + error.message);
    }
  } finally {
    loading.value = false;
  }
}

// 重置表单
function handleReset() {
  loadUserInfo();
  message.info('已重置');
}

// 修改密码
async function handleChangePassword() {
  try {
    await passwordFormRef.value?.validate();
    passwordLoading.value = true;

    await changePassword(passwordForm.oldPassword, passwordForm.newPassword, passwordForm.emailCode);
    
    message.success('密码修改成功，请重新登录');
    showPasswordModal.value = false;
    
    // 清空表单
    passwordForm.oldPassword = '';
    passwordForm.newPassword = '';
    passwordForm.confirmPassword = '';
    passwordForm.emailCode = '';
    
    // 延迟后登出
    setTimeout(async () => {
      await authStore.logout({ navigate: true });
    }, 1500);
  } catch (error: any) {
    if (error.message) {
      message.error('修改失败: ' + error.message);
    }
  } finally {
    passwordLoading.value = false;
  }
}

// 修改状态
async function handleStatusChange() {
  try {
    const result = await updateUser({ status: formData.status });
    console.log('状态更新结果:', result);
    authStore.updateUserInfo({ status: formData.status });
    socketStore.updateStatus(formData.status);
    message.success('状态修改成功');
  } catch (error: any) {
    console.error('状态修改失败:', error);
    message.error('状态修改失败: ' + error.message);
  }
}

// 返回
function goBack() {
  router.back();
}

onMounted(() => {
  loadUserInfo();
  void notificationSettings.load(authStore.currentUser!.id);
});
</script>

<style scoped lang="less">
.profile-card { border-color: #e2e8f0; box-shadow: 0 2px 8px #0f172a06; }
:deep {
  .n-card {
    border-radius: 12px;
  }
}
</style>

