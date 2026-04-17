export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response("Hello, 世界!");
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler;
