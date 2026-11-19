import http from "node:http";
import type { APIRequestContext } from "@playwright/test";

/** Sends around the request context: global fetch and node:http, with no permit. */
export async function rawClients(request: APIRequestContext): Promise<void> {
  const base = process.env.BASE_URL!;
  await (await fetch(`${base}/raw-fetch`)).text();
  await new Promise<void>((resolve, reject) => {
    http.get(`${base}/raw-http`, (res) => {
      res.resume();
      res.on("end", () => resolve());
    }).on("error", reject);
  });
  await request.get("/value");
}
