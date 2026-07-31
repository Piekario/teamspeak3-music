import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merges class names, letting a caller's utility win over a component's default.
 *
 * `clsx` flattens conditionals; `tailwind-merge` then resolves conflicts by Tailwind's own
 * rules, so passing `px-6` to a button that ships `px-4` replaces it instead of producing
 * two competing classes whose winner depends on stylesheet order.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
