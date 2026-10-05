export interface AnnotationPoint { x: number; y: number; }
export interface AnnotationStroke {
  id: string; kind: 'stroke'; color: string; width: number; opacity: number; points: AnnotationPoint[];
}
export interface AnnotationText {
  id: string; kind: 'text'; x: number; y: number; width: number; height: number;
  text: string; fontSize: number; color: string; background: string | null; opacity: number; vertical: boolean;
}
export type AnnotationObject = AnnotationStroke | AnnotationText;
export interface AnnotationLayer {
  id: string; type: 'pen' | 'text'; name: string; visible: boolean; locked: boolean;
  /** 原图 URL 为键，不依赖单双页槽位或临时页码。 */
  objects: Record<string, AnnotationObject[]>;
}
export interface ComicAnnotations {
  version: 1; revision: number; visible: boolean; layers: AnnotationLayer[];
  pages: Record<string, { width: number; height: number; signature: string }>;
}
export interface AnnotationSnapshot { document: ComicAnnotations; stalePages: string[]; }
