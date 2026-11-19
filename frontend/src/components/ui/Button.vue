<script setup lang="ts">
import { computed, useAttrs } from 'vue'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  variant?: 'primary' | 'secondary' | 'ghost' | 'destructive'
  size?: 'default' | 'small' | 'icon'
}>(), { variant: 'primary', size: 'default' })
const attrs = useAttrs()

const buttonVariants = cva('inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50', {
  variants: {
    variant: {
      primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
      secondary: 'border border-border bg-secondary text-secondary-foreground hover:bg-muted',
      ghost: 'text-foreground hover:bg-muted',
      destructive: 'bg-destructive text-white hover:bg-destructive/90'
    },
    size: {
      default: 'h-10 px-4 py-2',
      small: 'h-9 px-3',
      icon: 'size-9'
    }
  },
  defaultVariants: { variant: 'primary', size: 'default' }
})
type ButtonVariantProps = VariantProps<typeof buttonVariants>
const classes = computed(() => cn(buttonVariants({ variant: props.variant as ButtonVariantProps['variant'], size: props.size as ButtonVariantProps['size'] }), attrs.class as string | undefined))
</script>

<template>
  <button v-bind="attrs" :class="classes"><slot /></button>
</template>
