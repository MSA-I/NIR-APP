export async function readExactCount(request: PromiseLike<{
  count: number | null;
  error: { message: string } | null;
}>) {
  const result = await request;
  if (result.error) throw new Error(result.error.message);
  if (result.count == null) throw new Error('count_unavailable');
  return result.count;
}
