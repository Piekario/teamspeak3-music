import * as SliderPrimitive from '@radix-ui/react-slider';
import type { ComponentProps } from 'react';

import { cn } from '../../lib/utils.ts';

/**
 * Radix rather than a styled `input[type=range]`: arrow-key stepping, Home and End, and a
 * correctly announced role come for free, and the thumb can be styled without the
 * vendor-prefixed pseudo-element gymnastics a native range needs.
 */
export function Slider({
  className,
  ...props
}: ComponentProps<typeof SliderPrimitive.Root>) {
  return (
    <SliderPrimitive.Root
      className={cn(
        'relative flex w-full touch-none select-none items-center',
        'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-secondary">
        <SliderPrimitive.Range className="absolute h-full bg-primary" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        className="block size-4 rounded-full border border-primary/50 bg-background shadow
                   transition-colors focus-visible:outline-none focus-visible:ring-2
                   focus-visible:ring-ring disabled:pointer-events-none"
      />
    </SliderPrimitive.Root>
  );
}
