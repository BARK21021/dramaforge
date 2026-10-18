/**
 * @file cn.ts
 * @description 类名合并工具
 *
 * 基于 clsx + tailwind-merge，用于条件化拼接 Tailwind 类名并自动去重冲突。
 *
 * @example
 * cn("px-2", condition && "px-4", "text-red-500")  // → "px-4 text-red-500"
 */
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * 合并类名，自动处理 Tailwind 冲突
 * @param inputs - 类名输入（字符串、对象、数组皆可）
 * @returns 合并后的类名字符串
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
