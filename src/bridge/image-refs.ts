import type { ImageAttachmentLike } from './sanitize.js'

const IMAGE_REF_MAX = 128

export function rememberImageRef(
  imageRefs: Map<string, ImageAttachmentLike>,
  id: string,
  ref: ImageAttachmentLike,
): void {
  imageRefs.delete(id)
  imageRefs.set(id, ref)
  if (imageRefs.size <= IMAGE_REF_MAX) return
  const oldest = imageRefs.keys().next().value
  if (oldest !== undefined) imageRefs.delete(oldest)
}
