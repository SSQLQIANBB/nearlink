<script setup lang="ts">
import { ref, nextTick } from 'vue';
import { NInput, NButton, NCard, NScrollbar, useMessage } from 'naive-ui';
import { API_BASE_URL } from '@/utils/api';

interface Message {
  id: string;
  content: string;
  isUser: boolean;
  timestamp: Date;
}

const API_URL = `${API_BASE_URL}/chat`;

const messages = ref<Message[]>([
  {
    id: '0',
    content: '你好！我是 AI 助手，有什么可以帮你的吗？',
    isUser: false,
    timestamp: new Date(),
  },
]);

const inputMessage = ref('');
const isStreaming = ref(false);
const messageContainer = ref<HTMLElement>();
const messageApi = useMessage();

// 添加消息
function addMessage(content: string, isUser: boolean): Message {
  const message: Message = {
    id: Date.now().toString(),
    content,
    isUser,
    timestamp: new Date(),
  };
  messages.value.push(message);
  scrollToBottom();
  return message;
}

// 滚动到底部
function scrollToBottom() {
  nextTick(() => {
    if (!messageContainer.value) return;
    // 获取 n-scrollbar 内部实际滚动的内容容器
    const scrollContainer =
      document.querySelector('.n-scrollbar-content') || document.querySelector('.n-scrollbar-rail');
    // || messageContainer.value;

    if (scrollContainer) {
      // 使用 requestAnimationFrame 确保在浏览器重绘时执行滚动
      requestAnimationFrame(() => {
        // 强制触发布局计算（避免因DOM未完全更新导致的滚动位置错误）
        scrollContainer.scrollTop = scrollContainer.scrollHeight;

        // 双重确认滚动位置（处理可能的布局延迟）
        setTimeout(() => {
          messageContainer.value?.scrollTo({
            top: scrollContainer.scrollHeight,
          });
        }, 0);
      });
    }
  });
}

// 发送消息
async function sendMessage() {
  const message = inputMessage.value.trim();

  if (!message || isStreaming.value) {
    return;
  }

  // 添加用户消息
  addMessage(message, true);
  inputMessage.value = '';

  // 设置流式状态
  isStreaming.value = true;

  // 创建 AI 回复消息
  const aiMessage = addMessage('', false);

  try {
    // 发送 POST 请求
    const response = await fetch(`${API_URL}/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message }),
    });

    if (!response.ok) {
      throw new Error('请求失败');
    }

    // 读取 SSE 流
    const reader = response.body?.getReader();

    if (!reader) {
      throw new Error('无法读取响应流');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    reader.read().then(function processText({ done, value }): any {
      if (done) {
        console.log('SSE 流结束');

        return;
      }

      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;
      // console.log(buffer);

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      // console.log('lines:', lines)

      for (const line of lines) {
        if (line.startsWith('data:')) {
          try {
            const data = JSON.parse(line.slice(5).trim());

            if (data.type === 'text') {
              aiMessage.content += data.content;
              // 强制触发响应式更新
              messages.value = [...messages.value];
              scrollToBottom();
            } else if (data.type === 'done') {
              console.log('消息接收完成');
            }
          } catch (e) {
            console.warn('解析 SSE 数据失败:', line, e);
          }
        }
      }
      return reader.read().then(processText);
    });
  } catch (error) {
    console.error('错误:', error);
    aiMessage.content = '抱歉，发生了错误。请重试。';
    messageApi.error('发送消息失败');
  } finally {
    isStreaming.value = false;
  }
}

// 处理回车键
function handleKeyPress(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey && !isStreaming.value) {
    event.preventDefault();
    sendMessage();
  }
}
</script>

<template>
  <div class="chat-page">
    <n-card
      class="chat-container"
      :bordered="false"
      content-style="flex-grow: 1; height: 0; overflow: hidden"
    >
      <template #header>
        <div class="chat-header">
          <span class="header-icon">💬</span>
          <span class="header-title">AI 聊天助手</span>
        </div>
      </template>

      <!-- 消息列表 -->
      <n-scrollbar
        class="chat-messages"
        ref="messageContainer"
      >
        <div class="messages-wrapper">
          <div
            v-for="msg in messages"
            :key="msg.id"
            :class="['message', msg.isUser ? 'message-user' : 'message-ai']"
          >
            <div class="message-content">
              <div class="message-text">{{ msg.content }}</div>
              <div
                v-if="!msg.isUser && isStreaming && msg === messages[messages.length - 1]"
                class="message-cursor"
              >
                ▋
              </div>
            </div>
          </div>
        </div>
      </n-scrollbar>

      <!-- 输入区域 -->
      <template #footer>
        <div class="chat-input-container">
          <n-input
            v-model:value="inputMessage"
            type="textarea"
            :autosize="{ minRows: 1, maxRows: 4 }"
            placeholder="输入你的消息..."
            :disabled="isStreaming"
            @keypress="handleKeyPress"
            class="chat-input"
          />
          <n-button
            type="primary"
            :loading="isStreaming"
            :disabled="!inputMessage.trim() || isStreaming"
            @click="sendMessage"
            class="send-button"
            size="large"
          >
            {{ isStreaming ? '发送中...' : '发送' }}
          </n-button>
        </div>
      </template>
    </n-card>
  </div>
</template>

<style scoped>
.chat-page {
  width: 100%;
  height: 100vh;
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 20px;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
}

.chat-container {
  width: 100%;
  max-width: 900px;
  height: 85vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
  border-radius: 16px;
  overflow: hidden;
}

.chat-header {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 20px;
  font-weight: 600;
  color: #667eea;
}

.header-icon {
  font-size: 28px;
}

.chat-messages {
  flex: 1;
  /* height: 100%; */
  overflow: hidden;
  max-height: calc(85vh - 200px);
}

.messages-wrapper {
  padding: 20px;
  min-height: 100%;
}

.message {
  margin-bottom: 20px;
  display: flex;
  animation: slideIn 0.3s ease-out;
}

@keyframes slideIn {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.message-user {
  justify-content: flex-end;
}

.message-ai {
  justify-content: flex-start;
}

.message-content {
  max-width: 75%;
  padding: 14px 18px;
  border-radius: 16px;
  word-wrap: break-word;
  line-height: 1.6;
  display: flex;
  align-items: baseline;
  gap: 4px;
}

.message-user .message-content {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
}

.message-ai .message-content {
  background: #f5f5f5;
  color: #333;
}

.message-text {
  white-space: pre-wrap;
  word-break: break-word;
}

.message-cursor {
  animation: blink 1s infinite;
  font-weight: normal;
  color: #667eea;
}

@keyframes blink {
  0%,
  50% {
    opacity: 1;
  }
  51%,
  100% {
    opacity: 0;
  }
}

.chat-input-container {
  display: flex;
  gap: 12px;
  align-items: flex-end;
  padding-top: 16px;
}

.chat-input {
  flex: 1;
}

.send-button {
  min-width: 100px;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  border: none;
}

.send-button:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: 0 5px 15px rgba(102, 126, 234, 0.4);
}

/* 响应式设计 */
@media (max-width: 768px) {
  .chat-page {
    padding: 10px;
  }

  .chat-container {
    height: 95vh;
  }

  .message-content {
    max-width: 85%;
  }

  .chat-input-container {
    flex-direction: column;
    align-items: stretch;
  }

  .send-button {
    width: 100%;
  }
}
</style>
