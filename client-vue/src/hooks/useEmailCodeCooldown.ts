import { onMounted, onUnmounted, ref } from 'vue';
import type { EmailCodePurpose } from '@/api/auth';

const COOLDOWN_MS = 60_000;
const STORAGE_PREFIX = 'todesk:email-code-cooldown:';
const LAST_EMAIL_PREFIX = 'todesk:email-code-last-email:';

function storageKey(purpose: EmailCodePurpose, email: string) {
  return `${STORAGE_PREFIX}${purpose}:${email.trim().toLowerCase()}`;
}

export function useEmailCodeCooldown() {
  const now = ref(Date.now());
  const version = ref(0);
  const memory = new Map<string, number>();
  const lastEmails = new Map<EmailCodePurpose, string>();
  let timer: ReturnType<typeof setInterval> | undefined;

  function readDeadline(key: string) {
    try {
      const stored = window.localStorage.getItem(key);
      return stored === null ? memory.get(key) || 0 : Number(stored) || 0;
    } catch {
      return memory.get(key) || 0;
    }
  }

  function remaining(purpose: EmailCodePurpose, email: string) {
    void version.value;
    let targetEmail = email.trim();
    if (!targetEmail) {
      try {
        targetEmail = window.localStorage.getItem(`${LAST_EMAIL_PREFIX}${purpose}`) || '';
      } catch {
        targetEmail = lastEmails.get(purpose) || '';
      }
    }
    if (!targetEmail) return 0;
    return Math.min(
      60,
      Math.max(0, Math.ceil((readDeadline(storageKey(purpose, targetEmail)) - now.value) / 1000)),
    );
  }

  function start(purpose: EmailCodePurpose, email: string) {
    const key = storageKey(purpose, email);
    const deadline = Date.now() + COOLDOWN_MS;
    memory.set(key, deadline);
    lastEmails.set(purpose, email.trim().toLowerCase());
    try {
      window.localStorage.setItem(key, String(deadline));
      window.localStorage.setItem(`${LAST_EMAIL_PREFIX}${purpose}`, email.trim().toLowerCase());
    } catch {
      /* 浏览器禁用存储时，至少保持当前页面的倒计时。 */
    }
    now.value = Date.now();
    version.value += 1;
  }

  function refresh() {
    now.value = Date.now();
    version.value += 1;
  }

  onMounted(() => {
    timer = setInterval(refresh, 1000);
    window.addEventListener('storage', refresh);
  });
  onUnmounted(() => {
    if (timer) clearInterval(timer);
    window.removeEventListener('storage', refresh);
  });

  return { remaining, start };
}
