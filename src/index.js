export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/line/webhook" && request.method === "POST") {
      return new Response("LINE webhook received", {
        status: 200,
      });
    }

    return new Response("Worker is running", {
      status: 200,
    });
  },
};