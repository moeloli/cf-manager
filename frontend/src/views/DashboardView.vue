<template>
  <div>
    <n-space align="center" justify="space-between" style="width: 100%">
      <n-space align="center">
        <n-h2 style="margin: 0">仪表盘</n-h2>
        <n-tag size="small" type="info">今日额度</n-tag>
      </n-space>
      <n-space align="center">
        <n-select
          v-model:value="sortBy"
          :options="sortOptions"
          style="width: 160px"
        />
        <n-input
          v-model:value="searchQuery"
          placeholder="搜索账户..."
          clearable
          style="width: 200px"
        />
      </n-space>
    </n-space>

    <n-space v-if="globalStats.totalAccounts > 0" style="margin: 12px 0">
      <n-tag>共 {{ globalStats.totalAccounts }} 账户</n-tag>
      <n-tag v-if="globalStats.nearExhaustion > 0" type="warning">
        {{ globalStats.nearExhaustion }} 快耗尽
      </n-tag>
      <n-tag v-if="globalStats.exhaustedAccounts > 0" type="error">
        {{ globalStats.exhaustedAccounts }} 已耗尽
      </n-tag>
      <n-tag type="info">AI 总量 {{ globalStats.aiNeuronsTotal.toLocaleString() }}</n-tag>
    </n-space>

    <n-spin :show="quotaStore.loading" style="margin-top: 16px">
      <n-grid v-if="quotaWithResources.length > 0" cols="6 s:4 m:6 l:8 xl:10" :x-gap="8" :y-gap="8" responsive="screen">
        <n-gi v-for="acct in quotaWithResources" :key="acct.accountId">
          <CompactAccountCard :account-name="acct.accountName" :resources="acct.resources" />
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
import { calcPercentage } from '../utils/quota';
import CompactAccountCard from '../components/CompactAccountCard.vue';

const quotaStore = useQuotaStore();
const searchQuery = ref('');
const sortBy = ref('name');

const sortOptions = [
  { label: '名称 A-Z', value: 'name' },
  { label: '名称 Z-A', value: 'name-desc' },
  { label: '使用率 高→低', value: 'usage-desc' },
  { label: '使用率 低→高', value: 'usage-asc' },
];

function getMaxUsage(account: any) {
  return Math.max(
    0,
    ...account.resources.map((r: any) => {
      if (!r.limit) return 0;
      return Math.min(100, Math.round(((r.count || 0) / r.limit) * 100));
    }),
  );
}

const quotaWithResources = computed(() => {
  let accounts = quotaStore.quota.filter(
    (acct: any) => acct.resources && acct.resources.length > 0,
  );

  if (searchQuery.value) {
    const query = searchQuery.value.toLowerCase();
    accounts = accounts.filter((acct: any) =>
      acct.accountName.toLowerCase().includes(query),
    );
  }

  accounts = [...accounts].sort((a: any, b: any) => {
    switch (sortBy.value) {
      case 'name':
        return a.accountName.localeCompare(b.accountName);
      case 'name-desc':
        return b.accountName.localeCompare(a.accountName);
      case 'usage-desc':
        return getMaxUsage(b) - getMaxUsage(a);
      case 'usage-asc':
        return getMaxUsage(a) - getMaxUsage(b);
      default:
        return 0;
    }
  });

  return accounts;
});

const globalStats = computed(() => {
  const accounts = quotaStore.quota.filter(
    (acct: any) => acct.resources && acct.resources.length > 0,
  );
  const totalAccounts = accounts.length;

  const nearExhaustion = accounts.filter((acct: any) =>
    acct.resources.some((r: any) => {
      const pct = calcPercentage(r);
      return pct > 90;
    }),
  ).length;

  const exhaustedAccounts = accounts.filter((acct: any) =>
    acct.resources.some((r: any) => r.exhausted),
  ).length;

  const aiNeuronsTotal = accounts.reduce((sum: number, acct: any) => {
    const aiResource = acct.resources.find(
      (r: any) => r.resource === 'ai_neurons',
    );
    return sum + (aiResource?.count || 0);
  }, 0);

  return { totalAccounts, nearExhaustion, exhaustedAccounts, aiNeuronsTotal };
});

const auditLogs = ref<any[]>([]);
const loadingLogs = ref(false);

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
