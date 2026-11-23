'use client';
import { useParams } from 'next/navigation';
import { Editor } from '@/components/Editor';

export default function EditEnvelope() {
  const { id } = useParams<{ id: string }>();
  return <Editor id={id} />;
}
