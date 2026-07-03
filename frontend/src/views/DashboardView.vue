<template>
  <div>
    <n-space align="center">
      <n-h2 style="margin: 0">仪表盘</n-h2>
      <n-tag size="small" type="info">今日额度</n-tag>
    </n-space>

    <n-spin :show="quotaStore.loading" style="margin-top: 16px">
      <n-grid v-if="quotaWithResources.length > 0" :cols="gridCols" :x-gap="12" :y-gap="12" responsive="screen">
        <n-gi v-for="acct in quotaWithResources" :key="acct.accountId">
          <n-card :title="acct.accountName" size="small">
            <div v-for="r in acct.resources" :key="r.resource" style="margin-bottom: 14px;">
              <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                <n-text strong>{{ resourceLabel(r.resource) }}</n-text>
                <n-text depth="3">{{ formatValue(r) }}</n-text>
              </div>
              <n-progress
                type="line"
                :percentage="calcPercentage(r)"
                :height="14"
                :show-indicator="false"
                :status="calcPercentage(r) > 90 ? 'error' : calcPercentage(r) > 70 ? 'warning' : 'success'"
              />
            </div>
          </n-card>
        </n-gi>
      </n-grid>
      <n-empty v-if="!quotaStore.loading && quotaWithResources.length === 0" description="暂无账户数据" />
    </n-spin>

    <n-h3 style="margin-top: 24px">最近操作日志</n-h3>
    <n-data-table
      :columns="logColumns"
      :data="auditLogs"
      :loading="loadingLogs"
      size="small"
      :bordered="false"
      :scroll-x="700"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useQuotaStore } from '../stores/quotaStore';
import apiClient from '../api/client';
import type { DataTableColumns } from 'naive-ui';
import { formatCN } from '../utils/dateFormat';

const quotaStore = useQuotaStore();
const quotaWithResources = computed(() =>
  quotaStore.quota.filter((acct: any) => acct.resources && acct.resources.length > 0)
);
const gridCols = computed(() => {
  const count = quotaWithResources.value.length;
  return `1 s:${Math.min(count, 2)} m:${Math.min(count, 3)} l:${Math.min(count, 5)}`;
});
const auditLogs = ref<any[]>([]);
const loadingLogs = ref(false);

const resourceLabels: Record<string, string> = {
  workers_requests: 'Workers 请求',
  ai_neurons: 'AI 神经元',
  browser_render_seconds: '浏览器渲染',
};

function resourceLabel(resource: string) {
  return resourceLabels[resource] || resource;
}

function formatValue(r: any) {
  if (r.resource === 'browser_render_seconds') {
    const m = Math.floor(r.count / 60);
    const s = Math.round(r.count % 60);
    const lm = Math.floor(r.limit / 60);
    const ls = Math.round(r.limit % 60);
    return `${m > 0 ? m + '分' : ''}${s}秒 / ${lm}分${ls > 0 ? ls + '秒' : ''}`;
  }
  return `${(r.count || 0).toLocaleString()} / ${(r.limit || 0).toLocaleString()}`;
}

function calcPercentage(r: any) {
  if (!r.limit) return 0;
  return Math.min(100, Math.round(((r.count || 0) / r.limit) * 100));
}

const logColumns: DataTableColumns<any> = [
  { title: '时间', key: 'created_at', width: 180, render: (row) => formatCN(row.created_at) },
  { title: '账号', key: 'account_name', width: 120, render: (row) => row.account_name || '-' },
  { title: '操作', key: 'action', width: 150 },
  { title: '目标', key: 'target', width: 150 },
  { title: '详情', key: 'detail', ellipsis: { tooltip: true } },
  { title: '状态', key: 'status', width: 80 },
];

onMounted(async () => {
  quotaStore.fetchQuota();
  loadingLogs.value = true;
  try {
    const { data } = await apiClient.get('/audit-log');
    auditLogs.value = data;
  } finally {
    loadingLogs.value = false;
  }
});
</script>
