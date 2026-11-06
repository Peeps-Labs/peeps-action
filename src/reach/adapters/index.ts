/** The conventions the scanner knows. Adding one is a new file and a line here. */
import type { Convention } from "../convention";
import { express } from "./express";
import { fetchCalls } from "./fetch";
import { next } from "./next";
import { trigger } from "./trigger";
import { trpc } from "./trpc";

export function createConventions(tree: { files: string[]; read: (file: string) => string }): Convention[] {
  return [next, express, trpc, trigger, fetchCalls].map((factory) => factory(tree));
}
