export function listPage(): Response {
  return new Response("<!doctype html><title>Library</title><p>UI pending</p>", { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export function itemPage(_itemId: string, _weakContainment: boolean): Response {
  return new Response("<!doctype html><title>Item</title><p>UI pending</p>", { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
