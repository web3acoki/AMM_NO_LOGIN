<template>
  <div>
    <ul class="nav nav-pills mb-3" id="pills-tab" role="tablist">
      <li class="nav-item" role="presentation" v-for="t in tabs" :key="t.key">
        <button class="nav-link" :class="{ active: activeTab === t.key }" @click="activeTab = t.key">{{ t.label }}</button>
      </li>
    </ul>

    <div v-if="activeTab === 'pump'">
      <PumpForm />
    </div>
    <div v-else-if="activeTab === 'dump'">
      <DumpForm />
    </div>
    <div v-else-if="activeTab === 'volume'">
      <VolumeForm />
    </div>
    <div v-else>
      <RangeForm />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import PumpForm from './strategies/PumpForm.vue';
import DumpForm from './strategies/DumpForm.vue';
import VolumeForm from './strategies/VolumeForm.vue';
import RangeForm from './strategies/RangeForm.vue';

const tabs = [
  { key: 'pump', label: '拉盘' },
  { key: 'dump', label: '砸盘' },
  { key: 'volume', label: '刷量交易' },
  { key: 'range', label: '震荡模式' },
] as const;

const activeTab = ref<typeof tabs[number]['key']>('pump');
</script>


