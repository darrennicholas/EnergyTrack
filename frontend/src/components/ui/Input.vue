<script setup lang="ts">
import { useAttrs } from 'vue'
import { cn } from '../../lib/utils'

defineOptions({ inheritAttrs: false })
const model = defineModel<string>()
const props = withDefaults(defineProps<{ type?: string }>(), { type: 'text' })
const attrs = useAttrs()
</script>

<template>
  <input v-bind="attrs" v-model="model" :type="props.type" :class="cn('flex h-10 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50', attrs.class as string | undefined)" />
</template>
