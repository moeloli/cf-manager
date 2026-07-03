<template>
  <n-popover trigger="click" :show="showPopover" @update:show="showPopover = $event" placement="bottom">
    <template #trigger>
      <div class="compact-card" :class="{ 'compact-card--no-resources': !hasResources }" @click="showPopover = true">
        <span class="compact-card__name" :title="accountName">{{ displayName }}</span>
        <div class="compact-card__dots">
          <n-tooltip v-for="item in orderedResources" :key="item.resource" trigger="hover">
            <template #trigger>
              <span class="compact-card__dot" :style="{ backgroundColor: dotColor(item) }" />
            </template>
            {{ resourceLabel(item.resource) }}: {{ calcPercentage(item) }}%<span v-if="item.exhausted">（已耗尽）</span>
          </n-tooltip>
          <span v-for="i in emptyDots" :key="'empty-' + i" class="compact-card__dot" style="background-color: #ccc" />
        </div>
        <n-tooltip v-if="hasExhausted" trigger="hover">
          <template #trigger>
            <span class="compact-card__exhausted-dot" />
          </template>
          有资源已耗尽
        </n-tooltip>
      </div>
    </template>

    <div class="compact-card__popover">
      <div class="compact-card__popover-title">{{ accountName }}</div>
      <div v-for="item in orderedResources" :key="item.resource" class="compact-card__popover-row">
        <div class="compact-card__popover-label">
          <span>{{ resourceLabel(item.resource) }}</span>
          <n-tag v-if="item.exhausted" size="small" type="error" :bordered="false" style="margin-left: 6px;">已耗尽</n-tag>
          <span class="compact-card__popover-value">{{ formatValue(item) }}</span>
        </div>
        <n-progress
          type="line"
          :percentage="calcPercentage(item)"
          :height="14"
          :show-indicator="false"
          :status="item.exhausted ? 'error' : progressStatus(item)"
        />
      </div>
      <div v-if="!hasResources" style="color: #999; font-size: 13px;">暂无资源数据</div>
    </div>
  </n-popover>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';

interface Resource {
  resource: string;
  count: number;
  limit: number;
  exhausted?: boolean;
}

const props = defineProps<{
  accountName: string;
  resources: Resource[];
}>();

const showPopover = ref(false);

const resourceOrder = ['workers_requests', 'ai_neurons', 'browser_render_seconds'];

const resourceLabels: Record<string, string> = {
  workers_requests: 'Workers 请求',
  ai_neurons: 'AI 神经元',
  browser_render_seconds: '浏览器渲染',
};

function resourceLabel(resource: string) {
  return resourceLabels[resource] || resource;
}

function calcPercentage(r: Resource) {
  if (!r.limit) return 0;
  return Math.min(100, Math.round(((r.count || 0) / r.limit) * 100));
}

function formatValue(r: Resource) {
  if (r.resource === 'browser_render_seconds') {
    const m = Math.floor(r.count / 60);
    const s = Math.round(r.count % 60);
    const lm = Math.floor(r.limit / 60);
    const ls = Math.round(r.limit % 60);
    return `${m > 0 ? m + '分' : ''}${s}秒 / ${lm}分${ls > 0 ? ls + '秒' : ''}`;
  }
  return `${(r.count || 0).toLocaleString()} / ${(r.limit || 0).toLocaleString()}`;
}

function dotColor(r: Resource) {
  if (r.exhausted) return '#e03050';
  const pct = calcPercentage(r);
  if (pct > 100) return '#c03030';
  if (pct > 90) return '#d03050';
  if (pct > 70) return '#f0a020';
  return '#18a058';
}

function progressStatus(r: Resource): 'error' | 'warning' | 'success' {
  const pct = calcPercentage(r);
  if (pct > 90) return 'error';
  if (pct > 70) return 'warning';
  return 'success';
}

const orderedResources = computed(() => {
  const map = new Map(props.resources.map(r => [r.resource, r]));
  return resourceOrder.filter(key => map.has(key)).map(key => map.get(key)!);
});

const emptyDots = computed(() => Math.max(0, 3 - orderedResources.value.length));

const hasResources = computed(() => props.resources && props.resources.length > 0);

const hasExhausted = computed(() => props.resources && props.resources.some(r => r.exhausted));

const displayName = computed(() => {
  const name = props.accountName;
  return name.length > 8 ? name.slice(0, 7) + '…' : name;
});
</script>

<style scoped>
.compact-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 120px;
  height: 28px;
  padding: 0 4px;
  border: 1px solid #e0e0e6;
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 0.2s;
  background-color: #fff;
}

.compact-card:hover {
  background-color: #f5f5f5;
}

.compact-card--no-resources {
  opacity: 0.6;
  background-color: #f5f5f5;
}

.compact-card--no-resources:hover {
  background-color: #e8e8e8;
}

.compact-card__name {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 70px;
}

.compact-card__dots {
  display: flex;
  gap: 3px;
}

.compact-card__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.compact-card__exhausted-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background-color: #e03050;
  animation: pulse-exhausted 1.5s infinite;
}

@keyframes pulse-exhausted {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.compact-card__popover {
  min-width: 280px;
  padding: 4px 0;
}

.compact-card__popover-title {
  font-weight: bold;
  margin-bottom: 12px;
  font-size: 14px;
}

.compact-card__popover-row {
  margin-bottom: 12px;
}

.compact-card__popover-row:last-child {
  margin-bottom: 0;
}

.compact-card__popover-label {
  display: flex;
  justify-content: space-between;
  margin-bottom: 4px;
  font-size: 13px;
}

.compact-card__popover-value {
  color: #999;
}
</style>
