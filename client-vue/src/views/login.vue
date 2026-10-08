<template>
  <div class="login-page relative min-h-[100dvh] overflow-hidden flex items-center justify-center px-4 py-6 sm:p-6">
    <div class="login-scene" aria-hidden="true">
      <div class="star-field"><span v-for="index in 80" :key="index" class="star" :style="{ left: `${(index * 37.7) % 100}%`, top: `${(index * 23.3) % 100}%`, opacity: 0.2 + (index % 5) / 8 }"></span></div>
    </div>

    <div class="login-content relative z-20 w-full max-w-md">
      <img class="login-astronaut" src="@/assets/design/astronaut.svg" alt="" aria-hidden="true" />
      <n-card class="login-card shadow-2xl">
        <template #header>
          <div class="login-brand text-center">
            <div class="login-brand-lockup">
              <img class="login-brand-mark" src="/app-icon.png" alt="" aria-hidden="true" width="44" height="44" />
              <h1 class="login-brand-title">NearLink</h1>
            </div>
            <p class="login-brand-subtitle">远程协作平台 · 高效安全链接</p>
            <p class="mt-2 text-xs text-slate-500">{{ APP_VERSION_LABEL }}</p>
          </div>
        </template>

        <n-tabs v-model:value="activeTab" type="segment" animated>
          <!-- 登录 -->
          <n-tab-pane name="login" tab="登录">
            <n-form v-if="loginMethod === 'account'" ref="loginFormRef" :model="loginForm" :rules="loginRules" class="mt-4">
              <n-form-item path="username" label="账号 / 邮箱">
                <n-input
                  v-model:value="loginForm.username"
                  placeholder="请输入用户名或邮箱"
                  @keyup.enter="handleLogin"
                >
                  <template #prefix>
                    <n-icon><i class="iconfont icon-user" aria-hidden="true"></i></n-icon>
                  </template>
                </n-input>
              </n-form-item>

              <n-form-item path="password" label="密码">
                <n-input
                  v-model:value="loginForm.password"
                  type="password"
                  show-password-on="click"
                  placeholder="请输入登录密码"
                  @keyup.enter="handleLogin"
                >
                  <template #prefix>
                    <n-icon><i class="iconfont icon-lock" aria-hidden="true"></i></n-icon>
                  </template>
                </n-input>
              </n-form-item>

              <n-button
                type="primary"
                block
                size="large"
                :loading="loading"
                :disabled="loading"
                @click="handleLogin"
                class="mt-2"
              >
                登录
              </n-button>
              <div class="mt-3 flex items-center justify-between gap-3">
                <n-button class="login-link" text type="primary" @click="loginMethod = 'email'">验证码免密登录</n-button>
                <n-button class="login-link" text type="primary" @click="activeTab = 'forgot'">忘记密码？</n-button>
              </div>
            </n-form>
            <n-form v-else ref="emailLoginFormRef" :model="emailLoginForm" :rules="emailLoginRules" class="mt-4">
              <n-form-item path="email" label="已绑定邮箱">
                <n-input v-model:value="emailLoginForm.email" type="email" placeholder="请输入已绑定邮箱" @keyup.enter="handleEmailLogin" />
              </n-form-item>
              <n-form-item path="code" label="邮箱验证码">
                <div class="flex w-full gap-2">
                  <n-input v-model:value="emailLoginForm.code" maxlength="6" placeholder="6 位验证码" class="min-w-0 flex-1" @keyup.enter="handleEmailLogin" />
                  <n-button :loading="codeSending" :disabled="loginCooldown > 0" class="w-28 shrink-0 tabular-nums" @click="sendLoginCode">{{ loginCooldown > 0 ? `${loginCooldown}s 后重发` : '发送验证码' }}</n-button>
                </div>
              </n-form-item>
              <n-button type="primary" block size="large" :loading="loading" :disabled="loading" class="mt-2" @click="handleEmailLogin">登录</n-button>
              <div class="mt-3 text-center">
                <n-button class="login-link" text type="primary" @click="loginMethod = 'account'">返回账号密码登录</n-button>
              </div>
            </n-form>
          </n-tab-pane>

          <!-- 注册 -->
          <n-tab-pane name="register" tab="注册">
            <n-form ref="registerFormRef" :model="registerForm" :rules="registerRules" class="mt-4">
              <n-form-item path="username" label="用户名">
                <n-input
                  v-model:value="registerForm.username"
                  placeholder="设置登录账号"
                >
                  <template #prefix>
                    <n-icon><i class="iconfont icon-user" aria-hidden="true"></i></n-icon>
                  </template>
                </n-input>
              </n-form-item>

              <n-form-item path="password" label="密码">
                <n-input
                  v-model:value="registerForm.password"
                  type="password"
                  show-password-on="click"
                  placeholder="至少 6 位，包含大小写字母和数字"
                >
                  <template #prefix>
                    <n-icon><i class="iconfont icon-lock" aria-hidden="true"></i></n-icon>
                  </template>
                </n-input>
              </n-form-item>

              <n-form-item path="confirmPassword" label="确认密码">
                <n-input
                  v-model:value="registerForm.confirmPassword"
                  type="password"
                  show-password-on="click"
                  placeholder="请再次输入密码"
                >
                  <template #prefix>
                    <n-icon><i class="iconfont icon-lock" aria-hidden="true"></i></n-icon>
                  </template>
                </n-input>
              </n-form-item>

              <n-form-item path="nickname" label="昵称（可选）">
                <n-input
                  v-model:value="registerForm.nickname"
                  placeholder="团队展示名称"
                />
              </n-form-item>

              <n-form-item path="email" label="邮箱">
                <n-input v-model:value="registerForm.email" type="email" placeholder="用于接收验证码与找回密码" />
              </n-form-item>
              <n-form-item path="emailCode" label="邮箱验证码">
                <div class="flex w-full gap-2">
                  <n-input v-model:value="registerForm.emailCode" maxlength="6" placeholder="6 位验证码" class="min-w-0 flex-1" />
                  <n-button :loading="codeSending" :disabled="registerCooldown > 0" class="w-28 shrink-0 tabular-nums" @click="sendRegisterCode">{{ registerCooldown > 0 ? `${registerCooldown}s 后重发` : '发送验证码' }}</n-button>
                </div>
              </n-form-item>

              <n-button
                type="primary"
                block
                size="large"
                :loading="registerLoading"
                :disabled="registerLoading"
                @click="handleRegister"
                class="mt-2"
              >
                立即注册
              </n-button>
            </n-form>
          </n-tab-pane>
          <n-tab-pane name="forgot" tab="找回密码">
            <n-form ref="resetFormRef" :model="resetForm" :rules="resetRules" class="mt-4">
              <n-form-item path="email" label="已绑定邮箱">
                <n-input v-model:value="resetForm.email" type="email" placeholder="请输入已绑定邮箱" />
              </n-form-item>
              <n-form-item path="code" label="邮箱验证码">
                <div class="flex w-full gap-2">
                  <n-input v-model:value="resetForm.code" maxlength="6" placeholder="6 位验证码" class="min-w-0 flex-1" />
                  <n-button :loading="codeSending" :disabled="resetCooldown > 0" class="w-28 shrink-0 tabular-nums" @click="sendResetCode">{{ resetCooldown > 0 ? `${resetCooldown}s 后重发` : '发送验证码' }}</n-button>
                </div>
              </n-form-item>
              <n-form-item path="newPassword" label="新密码">
                <n-input v-model:value="resetForm.newPassword" type="password" show-password-on="click" placeholder="至少 6 位，包含大小写字母和数字" />
              </n-form-item>
              <n-form-item path="confirmPassword" label="确认新密码">
                <n-input v-model:value="resetForm.confirmPassword" type="password" show-password-on="click" placeholder="请再次输入新密码" />
              </n-form-item>
              <n-button type="primary" block size="large" :loading="resetLoading" @click="handleResetPassword">重置密码</n-button>
            </n-form>
          </n-tab-pane>
        </n-tabs>
      </n-card>

      <footer class="icp-record">浙ICP备2026052797号-1</footer>
    </div>
  </div>
</template>

<script setup lang="ts">
import { APP_VERSION_LABEL } from '@/config/appVersion';
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useMessage, type FormInst, type FormRules } from 'naive-ui';
import { register, resetPassword, sendEmailCode, type LoginCredentials, type User } from '@/api/auth';
import { useAuthStore } from '@/stores/auth';
import { createLoginController } from '@/services/loginController';
import { useEmailCodeCooldown } from '@/hooks/useEmailCodeCooldown';
import { isValidNewPassword, PASSWORD_RULE_MESSAGE } from '@/utils/passwordPolicy';

const router = useRouter();
const route = useRoute();
const message = useMessage();
const authStore = useAuthStore();

const activeTab = ref<'login' | 'register' | 'forgot'>('login');
const loginMethod = ref<'account' | 'email'>('account');
const registerLoading = ref(false);
const resetLoading = ref(false);
const codeSending = ref(false);
const emailCodeCooldown = useEmailCodeCooldown();
const loginController = createLoginController({
  login: (credentials: LoginCredentials) => authStore.login(credentials) as Promise<{
    accessToken: string;
    refreshToken: string;
    user: User;
    message?: string;
  }>,
  navigate: path => router.replace(path),
  showSuccess: text => message.success(text),
  showError: text => message.error(text),
});
const { loading } = loginController;

// 登录表单
const loginFormRef = ref<FormInst | null>(null);
const loginForm = ref({
  username: '',
  password: '',
});

const loginRules: FormRules = {
  username: [
    { required: true, message: '请输入用户名或邮箱', trigger: 'blur' },
  ],
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' },
  ],
};

// 注册表单
const registerFormRef = ref<FormInst | null>(null);
const registerForm = ref({
  username: '',
  password: '',
  confirmPassword: '',
  nickname: '',
  email: '',
  emailCode: '',
});

const registerRules: FormRules = {
  username: [
    { required: true, message: '请输入用户名', trigger: 'blur' },
    { min: 3, max: 20, message: '用户名长度在3-20个字符', trigger: 'blur' },
  ],
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' },
    { validator: (_rule, value) => isValidNewPassword(value), message: PASSWORD_RULE_MESSAGE, trigger: 'blur' },
  ],
  confirmPassword: [
    { required: true, message: '请再次输入密码', trigger: 'blur' },
    {
      validator: (_rule, value) => {
        return value === registerForm.value.password;
      },
      message: '两次输入的密码不一致',
      trigger: 'blur',
    },
  ],
  email: [
    { required: true, message: '请输入邮箱', trigger: 'blur' },
    { type: 'email', message: '邮箱格式不正确', trigger: 'blur' },
  ],
  emailCode: [
    { required: true, message: '请输入邮箱验证码', trigger: 'blur' },
    { pattern: /^\d{6}$/, message: '验证码为 6 位数字', trigger: 'blur' },
  ],
};

const emailLoginFormRef = ref<FormInst | null>(null);
const emailLoginForm = ref({ email: '', code: '' });
const emailLoginRules: FormRules = {
  email: [{ required: true, type: 'email', message: '请输入有效邮箱', trigger: 'blur' }],
  code: [{ required: true, pattern: /^\d{6}$/, message: '请输入 6 位验证码', trigger: 'blur' }],
};
const loginCooldown = computed(() => emailCodeCooldown.remaining('login', emailLoginForm.value.email));

const resetFormRef = ref<FormInst | null>(null);
const resetForm = ref({ email: '', code: '', newPassword: '', confirmPassword: '' });
const registerCooldown = computed(() => emailCodeCooldown.remaining('register', registerForm.value.email));
const resetCooldown = computed(() => emailCodeCooldown.remaining('reset', resetForm.value.email));
const resetRules: FormRules = {
  email: [{ required: true, type: 'email', message: '请输入有效邮箱', trigger: 'blur' }],
  code: [{ required: true, pattern: /^\d{6}$/, message: '请输入 6 位验证码', trigger: 'blur' }],
  newPassword: [
    { required: true, message: '请输入新密码', trigger: 'blur' },
    { validator: (_rule, value) => isValidNewPassword(value), message: PASSWORD_RULE_MESSAGE, trigger: 'blur' },
  ],
  confirmPassword: [{
    validator: (_rule, value) => value === resetForm.value.newPassword,
    message: '两次输入的密码不一致', trigger: 'blur',
  }],
};

async function sendCode(purpose: 'register' | 'reset' | 'login', email: string) {
  if (codeSending.value || emailCodeCooldown.remaining(purpose, email) > 0) return;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    message.error('请输入有效邮箱'); return;
  }
  codeSending.value = true;
  try {
    const result = await sendEmailCode(purpose, email);
    emailCodeCooldown.start(purpose, email);
    message.success(result.message);
  } catch (error: any) {
    message.error(error.message || '验证码发送失败');
  } finally { codeSending.value = false; }
}

const sendRegisterCode = () => sendCode('register', registerForm.value.email);
const sendResetCode = () => sendCode('reset', resetForm.value.email);
const sendLoginCode = () => sendCode('login', emailLoginForm.value.email);

async function handleResetPassword() {
  if (resetLoading.value) return;
  try {
    await resetFormRef.value?.validate();
    resetLoading.value = true;
    await resetPassword(resetForm.value.email, resetForm.value.code, resetForm.value.newPassword);
    message.success('密码已重置，请登录');
    resetForm.value = { email: '', code: '', newPassword: '', confirmPassword: '' };
    activeTab.value = 'login';
  } catch (error: any) {
    message.error(error.message || '密码重置失败');
  } finally { resetLoading.value = false; }
}

// 登录
async function handleLogin() {
  await loginController.submit({
    validate: () => loginFormRef.value?.validate() || Promise.resolve(),
    credentials: {
      username: loginForm.value.username,
      password: loginForm.value.password,
    },
    redirect: route.query.redirect,
  });
}

async function handleEmailLogin() {
  await loginController.submit({
    validate: () => emailLoginFormRef.value?.validate() || Promise.resolve(),
    credentials: {
      email: emailLoginForm.value.email,
      code: emailLoginForm.value.code,
    },
    redirect: route.query.redirect,
  });
}

// 注册
async function handleRegister() {
  if (registerLoading.value) return;
  registerLoading.value = true;
  try {
    await registerFormRef.value?.validate();

    const res = await register({
      username: registerForm.value.username,
      password: registerForm.value.password,
      nickname: registerForm.value.nickname || undefined,
      email: registerForm.value.email,
      emailCode: registerForm.value.emailCode,
    });

    authStore.setAuth(res.user, res.accessToken, res.refreshToken);
    message.success('注册成功');
    await router.replace('/remote');
  } catch (error: any) {
    message.error(error.message || '注册失败');
  } finally {
    registerLoading.value = false;
  }
}
</script>

<style scoped>
.login-page { background:radial-gradient(circle at 15% 20%,#1e40af59,transparent 45%),radial-gradient(circle at 85% 75%,#7c3aed40,transparent 50%),radial-gradient(circle at 50% 50%,#10b9811f,transparent 60%),linear-gradient(180deg,#070913,#0d1127); font-family:Inter,"PingFang SC","Microsoft YaHei",sans-serif; }
.login-content { padding-bottom:36px; }
.login-scene,.star-field { position:absolute; inset:0; pointer-events:none; }
.star { position:absolute; width:2px; height:2px; border-radius:50%; background:white; }
.login-astronaut { position:absolute; width:144px; height:144px; right:-80px; bottom:4px; z-index:30; pointer-events:none; animation:float 6s ease-in-out infinite; }
.login-brand-lockup { display:inline-flex; align-items:center; gap:8px; margin-bottom:4px; }
.login-brand-mark { display:block; width:44px; height:44px; flex:none; object-fit:contain; border-radius:12px; }
.login-brand-title { font-size:24px; font-weight:700; letter-spacing:-.025em; color:white; }
.login-brand-subtitle { font-size:12px; color:#94a3b8; letter-spacing:.05em; font-weight:500; }
.icp-record { position:absolute; bottom:0; width:100%; text-align:center; color:#94a3b8; font-size:11px; }
:deep(.login-card) { --n-color:rgba(18,24,43,.65) !important; --n-text-color:#cbd5e1 !important; border:1px solid #ffffff1f; border-radius:24px; background:rgba(18,24,43,.65); backdrop-filter:blur(20px); box-shadow:0 25px 50px -12px #0008,0 0 30px #10b9810d; }
:deep(.login-card .n-card-header) { padding:32px 32px 24px; }
:deep(.login-card .n-card__content) { padding:0 32px 32px; }
:deep(.login-card .n-tabs-rail) { padding:4px; border:1px solid #ffffff1a; border-radius:16px; background:#0f172a99; }
:deep(.login-card .n-tabs-capsule) { border-radius:12px; background:#059669; box-shadow:0 4px 6px -1px #0002; }
:deep(.login-card .n-tabs-tab) { --n-tab-text-color:#94a3b8 !important; --n-tab-text-color-hover:white !important; --n-tab-text-color-active:white !important; min-height:32px; font-size:12px; font-weight:600; }
:deep(.login-card .n-form-item-label) { color:#cbd5e1; font-size:12px; font-weight:500; padding-bottom:6px; }
:deep(.login-card .n-form-item-label__asterisk) { color:#34d399; }
:deep(.login-card .n-form-item-feedback-wrapper) { min-height:16px; }
:deep(.login-card .n-input) { --n-color:#0f172a80 !important; --n-color-focus:#0f172a80 !important; --n-text-color:white !important; --n-placeholder-color:#64748b !important; --n-border:1px solid #ffffff1a !important; --n-border-hover:1px solid #10b981 !important; --n-border-focus:1px solid #10b981 !important; --n-box-shadow-focus:0 0 0 1px #10b981 !important; --n-caret-color:#34d399 !important; --n-height:42px !important; border-radius:12px; }
/* 浏览器自动填充直接绘制在内部 input 上，需要覆盖其背景和文字颜色。 */
:deep(.login-card input:autofill) {
  box-shadow: 0 0 0 1000px #111a2e inset;
  -webkit-text-fill-color: #fff;
  caret-color: #34d399;
}
:deep(.login-card .n-input__prefix), :deep(.login-card .n-input__suffix) { color:#94a3b8; }
:deep(.login-card .n-button) { border-radius:12px; font-size:12px; }
:deep(.login-card .n-button--primary-type:not(.login-link)) { --n-color:#10b981 !important; --n-color-hover:#059669 !important; --n-color-pressed:#047857 !important; --n-border:0 !important; --n-border-hover:0 !important; --n-border-pressed:0 !important; --n-border-focus:0 !important; }
:deep(.login-card .n-button--primary-type:not(.login-link)) { background:linear-gradient(to right,#10b981,#14b8a6); box-shadow:0 10px 15px -3px #10b98140; font-size:14px; font-weight:600; }
:deep(.login-card .login-link) { --n-color:transparent !important; --n-color-hover:transparent !important; --n-text-color:#34d399 !important; --n-text-color-hover:#6ee7b7 !important; background:transparent; box-shadow:none; }
:deep(.login-card .n-button--default-type) { --n-color:#1e293b !important; --n-color-hover:#334155 !important; --n-text-color:#34d399 !important; --n-border:1px solid #ffffff1a !important; --n-border-hover:1px solid #ffffff33 !important; }
@keyframes float { 50% { transform:translateY(-15px) rotate(3deg); } }
@media (max-width:767px) { .login-page { height:100dvh; align-items:safe center; overflow-y:auto; scrollbar-width:none; } .login-page::-webkit-scrollbar { display:none; } .login-astronaut { width:112px; height:112px; right:-48px; bottom:-4px; } :deep(.login-card .n-card-header) { padding:24px 24px 24px; } :deep(.login-card .n-card__content) { padding:0 24px 24px; } }
@media (prefers-reduced-motion:reduce) { .login-astronaut { animation:none; } }
</style>
