let containerFetcher: (request: Request) => Promise<Response> = async () =>
  new Response('test Container fetcher is not configured', { status: 500 });

export function setTestContainerFetcher(fetcher: (request: Request) => Promise<Response>): void {
  containerFetcher = fetcher;
}

export function getContainer(): { fetch(request: Request): Promise<Response> } {
  return { fetch: (request) => containerFetcher(request) };
}
