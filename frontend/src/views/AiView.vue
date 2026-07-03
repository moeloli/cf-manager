<template>
  <div class="ai-view-root">
    <!-- 聊天消息区域 -->
    <div ref="chatContainer" style="flex: 1; overflow-y: auto; padding: 20px;">
      <!-- 欢迎页 -->
      <div v-if="messages.length === 0" style="text-align: center; padding: 40px 20px 40px;">
        <!-- AI 用量统计 (compact) -->
        <n-grid v-if="usageData.length > 0" :cols="6" :x-gap="8" :y-gap="8" responsive="screen" style="margin-bottom: 20px; text-align: left;">
          <n-gi v-for="u in usageData" :key="u.accountId">
            <n-popover trigger="click" placement="bottom">
              <template #trigger>
                <div class="ai-compact-card">
                  <span class="ai-compact-card__name" :title="u.accountName">{{ u.accountName.length > 8 ? u.accountName.slice(0, 7) + '…' : u.accountName }}</span>
                  <n-progress
                    type="line"
                    :percentage="Math.min(u.totalNeurons / 100, 100)"
                    :color="u.totalNeurons > 8000 ? '#e03050' : '#2080f0'"
                    :rail-color="'#e8e8e8'"
                    :height="6"
                    :show-indicator="false"
                    :style="{ flex: 1 }"
                  />
                  <span class="ai-compact-card__metric">{{ u.totalNeurons.toLocaleString() }}</span>
                </div>
              </template>
              <div style="min-width: 260px; padding: 4px 0;">
                <div style="font-weight: bold; margin-bottom: 10px;">{{ u.accountName }}</div>
                <div style="display: flex; justify-content: space-between; margin-bottom: 6px; font-size: 13px;">
                  <span>神经元总量</span>
                  <span><b style="color: #2080f0;">{{ u.totalNeurons.toLocaleString() }}</b> / 10,000</span>
                </div>
                <n-progress
                  type="line"
                  :percentage="Math.min(u.totalNeurons / 100, 100)"
                  :color="u.totalNeurons > 8000 ? '#e03050' : '#2080f0'"
                  :rail-color="'#e8e8e8'"
                  :height="12"
                  :show-indicator="false"
                  style="margin-bottom: 10px;"
                />
                <div v-if="u.models.length > 0" style="border-top: 1px solid #f0f0f0; padding-top: 8px;">
                  <div style="font-size: 12px; color: #888; margin-bottom: 6px;">模型明细 ({{ u.models.length }})</div>
                  <div
                    v-for="m in u.models"
                    :key="m.modelId"
                    style="display: flex; justify-content: space-between; padding: 3px 0; font-size: 13px; color: #555; border-bottom: 1px solid #f8f8f8;"
                  >
                    <span style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">{{ m.modelId.replace(/^@cf\//, '') }}</span>
                    <span style="flex-shrink: 0; margin-left: 12px;">{{ m.neurons.toLocaleString() }} / {{ m.requests.toLocaleString() }} 请求</span>
                  </div>
                </div>
              </div>
            </n-popover>
          </n-gi>
        </n-grid>
        <h1 style="font-size: 32px; margin-bottom: 36px; color: #1a1a1a; font-weight: 600;">有什么我能帮你的吗？</h1>
        <div style="display: flex; flex-wrap: wrap; gap: 12px; justify-content: center; max-width: 820px; margin: 0 auto;">
          <div
            v-for="s in suggestions"
            :key="s"
            style="cursor: pointer; padding: 12px 20px; font-size: 14px; border: 1px solid #e0e0e0; border-radius: 24px; background: white; color: #333; transition: all 0.2s;"
            @mouseenter="(e: MouseEvent) => { const t = e.target as HTMLElement; t.style.borderColor = '#2080f0'; t.style.color = '#2080f0'; }"
            @mouseleave="(e: MouseEvent) => { const t = e.target as HTMLElement; t.style.borderColor = '#e0e0e0'; t.style.color = '#333'; }"
            @click="useSuggestion(s)"
          >
            {{ s }}
          </div>
        </div>
      </div>

      <!-- 消息列表 -->
      <div v-for="(msg, idx) in messages" :key="idx" style="margin-bottom: 20px; display: flex; flex-direction: column; align-items: flex-end;">
        <!-- 用户消息 -->
        <div v-if="msg.role === 'user'" style="display: flex; justify-content: flex-end; width: 100%;">
          <div style="background: #18a058; color: white; padding: 12px 16px; border-radius: 16px 16px 4px 16px; max-width: 70%; font-size: 15px; line-height: 1.6; white-space: pre-wrap;">{{ msg.content }}</div>
        </div>
        <!-- AI 消息 -->
        <div v-else style="display: flex; justify-content: flex-start; width: 100%; gap: 10px;">
          <div style="width: 36px; height: 36px; border-radius: 50%; background: #2080f0; color: white; display: flex; align-items: center; justify-content: center; font-size: 14px; flex-shrink: 0;">AI</div>
          <div style="background: #f5f5f5; padding: 12px 16px; border-radius: 4px 16px 16px 16px; max-width: 70%; font-size: 15px; line-height: 1.6;">
            <!-- 思考过程 -->
            <div v-if="msg.reasoning" style="margin-bottom: 10px;">
              <div
                style="cursor: pointer; display: flex; align-items: center; gap: 6px; color: #888; font-size: 13px; user-select: none;"
                @click="msg.reasoningExpanded = !msg.reasoningExpanded"
              >
                <span style="font-size: 12px; transition: transform 0.2s; display: inline-block;" :style="{ transform: msg.reasoningExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }">▶</span>
                 思考过程{{ msg.thinkingDone ? '' : '（进行中...）' }}
              </div>
              <div v-show="msg.reasoningExpanded" style="white-space: pre-wrap; color: #666; font-size: 13px; background: #e8e8e8; padding: 10px; border-radius: 6px; margin-top: 6px;">{{ msg.reasoning }}</div>
            </div>
            <!-- 回答内容 -->
            <div style="white-space: pre-wrap;">{{ msg.content }}</div>
            <!-- 加载中 -->
            <div v-if="msg.loading" style="color: #999;">
              <n-spin size="small" /> 思考中...
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 底部输入区域 -->
    <div class="ai-input-bar">
      <!-- 顶部工具栏 -->
      <div class="ai-toolbar">
        <n-select
          v-model:value="selectedAccount"
          :options="accountOptions"
          placeholder="账户"
          class="ai-select-account"
          size="small"
        />
        <n-select
          v-model:value="selectedModel"
          :options="modelOptions"
          placeholder="选择模型"
          style="flex: 1; min-width: 0;"
          :loading="modelsLoading"
          size="small"
          filterable
          @update:value="onModelChange"
        />
        <n-button v-if="messages.length > 0" size="small" quaternary @click="messages = []">
          + 新对话
        </n-button>
      </div>
      <!-- 输入框 -->
      <div style="display: flex; gap: 10px; align-items: flex-end;">
        <n-input
          v-model:value="prompt"
          type="textarea"
          placeholder="发消息..."
          :rows="2"
          :disabled="inferring"
          @keydown.enter.exact.prevent="sendMessage"
          style="flex: 1;"
        />
        <n-button type="primary" @click="sendMessage" :loading="inferring" :disabled="!selectedModel || !prompt.trim()" style="height: 40px;">
          发送
        </n-button>
        <n-button @click="stopInference" :disabled="!inferring" style="height: 40px;">停止</n-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, watch, onMounted, nextTick } from 'vue';
import { useMessage } from 'naive-ui';
import { accountsApi } from '../api/accounts';

interface AiUsageItem {
  accountId: string;
  accountName: string;
  totalNeurons: number;
  models: Array<{ modelId: string; neurons: number; requests: number }>;
  expanded?: boolean;
}
const usageData = ref<AiUsageItem[]>([]);

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  reasoningExpanded?: boolean;
  thinkingDone?: boolean;
  loading?: boolean;
}

const message = useMessage();
const selectedAccount = ref<string>('auto'); // 'auto' = 自动分配
const accountOptions = ref<{ label: string; value: string }[]>([]);
const selectedModel = ref('');
const modelOptions = ref<{ label: string; value: string }[]>([]);
const modelsLoading = ref(false);
const prompt = ref('');
const messages = ref<ChatMessage[]>([]);
const inferring = ref(false);
const chatContainer = ref<HTMLElement>();
let abortController: AbortController | null = null;

// 等待浏览器绘制完成一帧
function waitFrame(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

const suggestions = [
  '今天天气怎么样？',
  '帮我写一封请假邮件',
  '推荐几部好看的电影',
  '如何快速学习英语？',
  '帮我制定一个健身计划',
  '有什么好吃的家常菜推荐吗？',
];

async function fetchAccounts() {
  try {
    const { data } = await accountsApi.getAll();
    const accounts = (data.accounts || []).filter((a: any) => a.is_active && (a.enabled_features || '').includes('ai')).map((a: any) => ({
      label: a.name,
      value: a.account_id || String(a.id), // Use account_id (Cloudflare ID) for AI requests
    }));
    accountOptions.value = [
      { label: '🤖 自动分配', value: 'auto' },
      ...accounts,
    ];
  } catch {
    accountOptions.value = [{ label: '🤖 自动分配', value: 'auto' }];
  }
}

async function fetchModels() {
  modelsLoading.value = true;
  try {
    const token = localStorage.getItem('api_token');
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    
    // Filter to only text-generation models (chat/completions compatible)
    const response = await fetch('/api/v1/models?task=text-generation', { headers });
    if (!response.ok) throw new Error(`Failed to fetch models: ${response.status}`);
    
    const data = await response.json();
    modelOptions.value = (data.data || []).map((m: any) => {
      const fullName = m.id || m.name;
      const shortName = fullName.replace(/^@cf\//, '');
      return { label: shortName, value: fullName };
    });
    
    if (modelOptions.value.length && !modelOptions.value.find(o => o.value === selectedModel.value)) {
      selectedModel.value = modelOptions.value[0].value;
    }
  } catch {
    // models fetch may fail silently
  } finally {
    modelsLoading.value = false;
  }
}

function onModelChange() {
  // 模型改变时不需要额外操作
}

function useSuggestion(s: string) {
  prompt.value = s;
  sendMessage();
}

async function sendMessage() {
  if (!selectedModel.value || !prompt.value.trim()) return;

  const userMsg: ChatMessage = { role: 'user', content: prompt.value };
  messages.value.push(userMsg);

  const aiMsg = reactive<ChatMessage>({ role: 'assistant', content: '', reasoning: '', reasoningExpanded: false, thinkingDone: false, loading: true });
  messages.value.push(aiMsg);

  const currentPrompt = prompt.value;
  prompt.value = '';
  inferring.value = true;
  abortController = new AbortController();

  scrollToBottom();

  try {
    const token = localStorage.getItem('api_token');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    
    // Build messages array (exclude loading messages)
    const historyMessages = messages.value
      .filter(m => !m.loading)
      .slice(0, -1) // exclude current user message, will be added below
      .map(m => ({ role: m.role, content: m.content }));
    
    const response = await fetch('/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        ...headers,
        ...(selectedAccount.value && selectedAccount.value !== 'auto' ? { 'X-Account-ID': selectedAccount.value } : {}),
      },
      body: JSON.stringify({
        model: selectedModel.value,
        messages: [...historyMessages, { role: 'user', content: currentPrompt }],
        stream: true,
      }),
      signal: abortController.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') {
            aiMsg.thinkingDone = true;
            break;
          }
          try {
            const parsed = JSON.parse(data);
            const delta = parsed?.choices?.[0]?.delta;
            
            if (delta?.reasoning_content || delta?.reasoning) {
              // Reasoning/thinking content
              const reasoningText = delta.reasoning_content || delta.reasoning;
              aiMsg.reasoning = (aiMsg.reasoning || '') + reasoningText;
              aiMsg.reasoningExpanded = true;
              await nextTick();
              await waitFrame(); // 等浏览器绘制
            }
            
            if (delta?.content) {
              // Actual response content
              aiMsg.thinkingDone = true;
              aiMsg.content += delta.content;
              await nextTick();
              await waitFrame(); // 等浏览器绘制
            }
            
            if (parsed.error) {
              message.error(parsed.error.message || JSON.stringify(parsed.error));
            }
          } catch (e) {
            console.warn('Failed to parse SSE:', data);
          }
        }
      }
      scrollToBottom();
    }

    aiMsg.loading = false;
    if (!aiMsg.content && !aiMsg.reasoning) {
      aiMsg.content = '（模型返回了空响应）';
    }
  } catch (e: any) {
    if (e.name !== 'AbortError') {
      aiMsg.content = `错误：${e?.errorMessage || e?.message || '推理失败'}`;
    } else {
      aiMsg.content += '\n\n（已停止）';
    }
    aiMsg.loading = false;
  } finally {
    inferring.value = false;
    abortController = null;
    scrollToBottom();
  }
}

function stopInference() {
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
}

function scrollToBottom() {
  nextTick(() => {
    if (chatContainer.value) {
      chatContainer.value.scrollTop = chatContainer.value.scrollHeight;
    }
  });
}

async function fetchUsage() {
  try {
    const token = localStorage.getItem('api_token');
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    
    const response = await fetch('/api/ai/usage', { headers });
    
    if (!response.ok) throw new Error(`Failed to fetch usage: ${response.status}`);
    
    const result = await response.json();
    
    // Handle both wrapped { success, data } and unwrapped array formats
    const data = result.data || result;
    // Ensure totalNeurons always has a default value (0 if missing)
    usageData.value = (data || []).map((d: any) => ({ 
      ...d, 
      totalNeurons: d.totalNeurons || 0,
      expanded: false 
    }));
  } catch (error) {
    console.error('[AiView] Failed to fetch usage:', error);
    usageData.value = [];
  }
}

onMounted(() => {
  fetchAccounts();
  fetchModels();
  fetchUsage();
});

watch(selectedAccount, () => {
  fetchModels();
});
</script>

<style scoped>
.ai-view-root {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 120px);
}

.ai-input-bar {
  border-top: 1px solid #eee;
  padding: 12px 20px;
  background: white;
}

.ai-toolbar {
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.ai-select-account {
  width: 180px;
}

.ai-compact-card {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 180px;
  height: 28px;
  padding: 0 8px;
  border: 1px solid #e0e0e6;
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 0.2s;
  background-color: #fff;
}
.ai-compact-card:hover { background-color: #f5f5f5; }
.ai-compact-card__name {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 70px;
  flex-shrink: 0;
}
.ai-compact-card__metric {
  font-size: 11px;
  color: #666;
  flex-shrink: 0;
  white-space: nowrap;
}

@media (max-width: 768px) {
  .ai-view-root {
    height: calc(100vh - 80px);
  }
  .ai-input-bar {
    padding: 8px 12px;
  }
  .ai-toolbar {
    flex-wrap: wrap;
    gap: 6px;
  }
  .ai-select-account {
    width: 100%;
  }
}
</style>
