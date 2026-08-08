export class Nextura {
  constructor({ apiKey, baseURL = "https://tropical-bobbie-redcore-99fcb114.koyeb.app" } = {}) {
    if (!apiKey) throw new Error("Nextura apiKey wajib diisi");
    this.apiKey = apiKey;
    this.baseURL = String(baseURL).replace(/\/+$/, "");
  }

  async request(path, options = {}) {
    const response = await fetch(`${this.baseURL}${path}`, {
      method: options.method || "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        ...(options.headers || {})
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!response.ok) {
      const error = new Error(data?.error?.message || data?.message || `HTTP ${response.status}`);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  chat = {
    create: async ({ message, messages, model = "Nextura/cortexa-max", thinking = "cepat", search = false, max_tokens } = {}) => {
      return this.request("/v1/nextura/chat", {
        body: { message, messages, model, thinking, search, max_tokens }
      });
    }
  };

  models = {
    list: async () => {
      const response = await fetch(`${this.baseURL}/v1/models`, {
        headers: { "x-api-key": this.apiKey }
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message || `HTTP ${response.status}`);
      return data;
    }
  };
}

export default Nextura;
