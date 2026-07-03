<template>
  <div>
    <n-h2>浏览器渲染</n-h2>

    <!-- 用量统计 (compact) -->
    <n-grid v-if="usageList.length > 0" :cols="6" :x-gap="8" :y-gap="8" responsive="screen" style="margin-bottom: 16px;">
      <n-gi v-for="u in usageList" :key="u.accountId">
        <n-popover trigger="click" placement="bottom">
          <template #trigger>
            <div class="br-compact-card">
              <span class="br-compact-card__name" :title="u.accountName">{{ u.accountName.length > 8 ? u.accountName.slice(0, 7) + '…' : u.accountName }}</span>
              <n-progress
                type="line"
                :percentage="Math.min(u.used / u.limit * 100, 100)"
                :color="u.used > 500 ? '#e03050' : '#2080f0'"
                :rail-color="'#e8e8e8'"
                :height="6"
                :show-indicator="false"
                :style="{ flex: 1 }"
              />
              <span class="br-compact-card__metric" :style="{ color: u.used > 500 ? '#e03050' : '#666' }">{{ formatSeconds(u.used) }}</span>
            </div>
          </template>
          <div style="min-width: 220px; padding: 4px 0;">
            <div style="font-weight: bold; margin-bottom: 10px;">{{ u.accountName }}</div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 6px; font-size: 13px;">
              <span>已用 / 总量</span>
              <span><b :style="{ color: u.used > 500 ? '#e03050' : '#2080f0' }">{{ formatSeconds(u.used) }}</b> / {{ formatSeconds(u.limit) }}</span>
            </div>
            <n-progress
              type="line"
              :percentage="Math.min(u.used / u.limit * 100, 100)"
              :color="u.used > 500 ? '#e03050' : '#2080f0'"
              :rail-color="'#e8e8e8'"
              :height="12"
              :show-indicator="false"
              style="margin-bottom: 10px;"
            />
            <div style="display: flex; justify-content: space-between; font-size: 13px;">
              <span>使用率</span>
              <span>{{ Math.min(Math.round(u.used / u.limit * 100), 100) }}%</span>
            </div>
          </div>
        </n-popover>
      </n-gi>
    </n-grid>

    <n-card size="small" style="margin-bottom: 16px">
      <n-space vertical>
        <n-space align="center" :wrap="true">
          <n-select
            v-model:value="selectedAccount"
            :options="accountOptions"
            placeholder="账户"
            style="width: 180px; max-width: 45vw;"
            size="small"
          />
          <n-input
            v-model:value="url"
            placeholder="输入 URL"
            style="width: 400px; max-width: 60vw"
            :disabled="rendering"
            @keyup.enter="handleRender"
          />
          <n-button type="primary" @click="handleRender" :loading="rendering" :disabled="!url.trim()">
            开始渲染
          </n-button>
        </n-space>
        <n-radio-group v-model:value="renderMode" size="small">
          <n-radio-button value="screenshot">截图</n-radio-button>
          <n-radio-button value="content">HTML</n-radio-button>
          <n-radio-button value="markdown">Markdown</n-radio-button>
          <n-radio-button value="pdf">PDF</n-radio-button>
          <n-radio-button value="links">链接提取</n-radio-button>
        </n-radio-group>
      </n-space>
    </n-card>

    <n-spin :show="rendering">
      <!-- 截图结果 -->
      <n-card v-if="result?.screenshot" title="截图" size="small" style="margin-bottom: 16px">
        <template #header-extra>
          <n-button size="tiny" @click="downloadScreenshot">下载</n-button>
        </template>
        <img :src="result.screenshot" style="max-width: 100%; border: 1px solid #eee; border-radius: 4px" />
      </n-card>

      <!-- HTML 渲染结果 -->
      <n-card v-if="result?.html" title="HTML 渲染" size="small" style="margin-bottom: 16px">
        <template #header-extra>
          <n-space>
            <n-button size="tiny" :type="htmlViewMode === 'render' ? 'primary' : 'default'" @click="htmlViewMode = 'render'">预览</n-button>
            <n-button size="tiny" :type="htmlViewMode === 'source' ? 'primary' : 'default'" @click="htmlViewMode = 'source'">源码</n-button>
          </n-space>
        </template>
        <iframe
          v-if="htmlViewMode === 'render'"
          :srcdoc="result.html"
          style="width: 100%; height: 600px; border: 1px solid #eee; border-radius: 4px;"
          sandbox="allow-same-origin"
        />
        <n-code v-else :code="result.html" language="html" :word-wrap="true" style="max-height: 600px; overflow: auto;" />
      </n-card>

      <!-- Markdown 结果 -->
      <n-card v-if="result?.markdown" title="Markdown" size="small" style="margin-bottom: 16px">
        <n-code :code="result.markdown" language="markdown" :word-wrap="true" style="max-height: 600px; overflow: auto;" />
      </n-card>

      <!-- PDF 结果 -->
      <n-card v-if="result?.pdf" title="PDF" size="small" style="margin-bottom: 16px">
        <template #header-extra>
          <n-button size="tiny" @click="downloadPdf">下载 PDF</n-button>
        </template>
        <iframe :src="result.pdf" style="width: 100%; height: 700px; border: 1px solid #eee;" />
      </n-card>

      <!-- 链接提取结果 -->
      <n-card v-if="result?.links" title="提取的链接" size="small" style="margin-bottom: 16px">
        <div v-if="Array.isArray(result.links)">
          <div v-for="(link, i) in result.links" :key="i" style="padding: 4px 0; border-bottom: 1px solid #f0f0f0; font-size: 13px;">
            <a :href="link" target="_blank" style="color: #2080f0;">{{ link }}</a>
          </div>
          <div style="margin-top: 8px; color: #888; font-size: 13px;">共 {{ result.links.length }} 个链接</div>
        </div>
        <n-code v-else :code="JSON.stringify(result.links, null, 2)" language="json" :word-wrap="true" />
      </n-card>

      <!-- 耗时 -->
      <div v-if="result" style="color: #888; font-size: 13px; margin-top: 8px;">
        浏览器用时: {{ result.browserMsUsed ? (result.browserMsUsed / 1000).toFixed(2) + 's' : result.duration?.toFixed(2) + 's' }}
      </div>

      <n-empty v-if="!result && !rendering" description="输入 URL 并点击开始渲染" style="padding: 60px 0" />
    </n-spin>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useMessage } from 'naive-ui';
import { browserRenderApi, type RenderMode } from '../api/browserRender';
import { accountsApi } from '../api/accounts';

const message = useMessage();
const url = ref('');
const selectedAccount = ref<string>('auto');
const accountOptions = ref<{ label: string; value: string }[]>([]);
interface UsageItem { accountId: number; accountName: string; used: number; limit: number; }
const usageList = ref<UsageItem[]>([]);
const renderMode = ref<RenderMode>('screenshot');
const rendering = ref(false);
const htmlViewMode = ref<'render' | 'source'>('render');
const result = ref<any>(null);

async function fetchAccounts() {
  try {
    const { data } = await accountsApi.getAll();
    const accounts = (data.accounts || []).filter((a: any) => a.is_active && (a.enabled_features || '').includes('browser_render')).map((a: any) => ({
      label: a.name,
      value: String(a.id),
    }));
    accountOptions.value = [{ label: '自动分配', value: 'auto' }, ...accounts];
  } catch {
    accountOptions.value = [{ label: '自动分配', value: 'auto' }];
  }
}

async function handleRender() {
  if (!url.value.trim()) return;
  rendering.value = true;
  result.value = null;
  try {
    const acctId = selectedAccount.value !== 'auto' ? Number(selectedAccount.value) : undefined;
    const { data } = await browserRenderApi.render(url.value, renderMode.value, acctId);
    if (data.screenshot && !data.screenshot.startsWith('data:')) {
      data.screenshot = `data:image/png;base64,${data.screenshot}`;
    }
    result.value = data;
    message.success(`渲染完成 (${data.duration?.toFixed(1)}s)`);
    fetchUsage();
  } finally {
    rendering.value = false;
  }
}

function downloadScreenshot() {
  if (!result.value?.screenshot) return;
  const a = document.createElement('a');
  a.href = result.value.screenshot;
  a.download = `screenshot-${new Date().getTime()}.png`;
  a.click();
}

function downloadPdf() {
  if (!result.value?.pdf) return;
  const a = document.createElement('a');
  a.href = result.value.pdf;
  a.download = `page-${new Date().getTime()}.pdf`;
  a.click();
}

function formatSeconds(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return m > 0 ? `${m}分${sec}秒` : `${sec}秒`;
}

async function fetchUsage() {
  try {
    const { data } = await browserRenderApi.getQuota();
    usageList.value = (data || [])
      .map((acct: any) => {
        const br = (acct.resources || []).find((r: any) => r.resource === 'browser_render_seconds');
        return br ? { accountId: acct.accountId, accountName: acct.accountName, used: br.count || 0, limit: br.limit || 600 } : null;
      })
      .filter(Boolean) as UsageItem[];
  } catch {
    usageList.value = [];
  }
}

onMounted(() => {
  fetchAccounts();
  fetchUsage();
});
</script>

<style scoped>
.br-compact-card {
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
.br-compact-card:hover { background-color: #f5f5f5; }
.br-compact-card__name {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 70px;
  flex-shrink: 0;
}
.br-compact-card__metric {
  font-size: 11px;
  color: #666;
  flex-shrink: 0;
  white-space: nowrap;
}
</style>
