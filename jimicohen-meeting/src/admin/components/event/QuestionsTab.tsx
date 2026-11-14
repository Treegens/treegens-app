import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Lock, MessageSquarePlus, Plus, Trash2 } from 'lucide-react';
import type { Question, QuestionType } from '../../../../shared/types';
import { Button, EmptyState, Field, IconButton, Input, SegmentedControl, Select, Switch, Textarea } from '../../../ui';
import { localId } from '../../format';
import { NumberField } from '../Fields';
import { FieldGroup, Section } from '../Page';
import type { TabProps } from './shared';

const TYPE_LABEL: Record<QuestionType, string> = {
  text: 'Short answer',
  textarea: 'Long answer',
  select: 'Dropdown',
  radio: 'Pick one',
  checkbox: 'Pick several',
  url: 'Link',
  number: 'Number',
};

const TYPES: QuestionType[] = ['text', 'textarea', 'select', 'radio', 'checkbox', 'url', 'number'];
const hasOptions = (t: QuestionType) => t === 'select' || t === 'radio' || t === 'checkbox';

export function QuestionsTab({ draft, update, errors }: TabProps) {
  const questions = draft.questions;
  const [focusId, setFocusId] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const phoneLocation = draft.locations.some((l) => l.type === 'phone_host_calls');

  useEffect(() => {
    if (!focusId) return;
    listRef.current?.querySelector<HTMLInputElement>(`[data-q="${focusId}"] input`)?.focus();
    setFocusId(null);
  }, [focusId]);

  const setQuestion = (id: string, patch: Partial<Question>) => update({ questions: questions.map((q) => (q.id === id ? { ...q, ...patch } : q)) });
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= questions.length) return;
    const next = questions.slice();
    [next[i], next[j]] = [next[j], next[i]];
    update({ questions: next });
  };
  const add = () => {
    const id = localId('q');
    update({ questions: [...questions, { id, label: '', type: 'text', required: false }] });
    setFocusId(id);
  };

  return (
    <>
      <Section title="Always asked" description="Name and email are part of every booking. Decide whether to ask for a phone number and guests too.">
        <ul role="list" className="adm-fixed">
          <li>
            <Lock size={14} aria-hidden="true" />
            <span>Name</span>
            <span className="adm-quiet">Required</span>
          </li>
          <li>
            <Lock size={14} aria-hidden="true" />
            <span>Email</span>
            <span className="adm-quiet">Required</span>
          </li>
        </ul>
        <FieldGroup
          label="Phone number"
          error={errors.phone}
          hint={
            phoneLocation
              ? 'One of your locations is "you call them", so a number is always asked for.'
              : 'Text reminders and AI reminder calls only go to people who give a number and agree to them.'
          }
        >
          <SegmentedControl
            aria-label="Phone number"
            value={draft.phone}
            onChange={(phone) => update({ phone })}
            options={[
              { value: 'hidden', label: 'Do not ask' },
              { value: 'optional', label: 'Optional' },
              { value: 'required', label: 'Required' },
            ]}
          />
        </FieldGroup>
        <Switch labelSide="start" checked={draft.allowGuests} onChange={(allowGuests) => update({ allowGuests })} label="Let people bring guests" description="They can add email addresses, and those guests get the invitation too." />
        {draft.allowGuests ? (
          <Field label="Guests per booking" error={errors.maxGuests}>
            <NumberField value={draft.maxGuests} min={1} max={20} suffix="at most" onChange={(maxGuests) => update({ maxGuests })} className="adm-w-md" />
          </Field>
        ) : null}
      </Section>

      <Section title="Your questions" description="Anything you want to know before the meeting. Answers arrive with the booking and in the calendar event.">
        {questions.length === 0 ? (
          <div className="adm-well">
            <EmptyState compact align="start" icon={<MessageSquarePlus />} title="No questions yet" description="Ask what they want to talk about, where they work, or anything that helps you prepare." />
          </div>
        ) : (
          <ul role="list" className="adm-questions" ref={listRef}>
            {questions.map((q, i) => {
              const labelErr = errors[`questions.${i}.label`];
              const optErr = errors[`questions.${i}.options`];
              return (
                <li key={q.id} className="adm-question" data-q={q.id}>
                  <div className="adm-question__head">
                    <span className="adm-question__num" aria-hidden="true">
                      {i + 1}
                    </span>
                    <div className="adm-question__label">
                      <Field label={`Question ${i + 1}`} hideLabel error={labelErr}>
                        <Input value={q.label} maxLength={200} placeholder="What would you like to ask?" onChange={(e) => setQuestion(q.id, { label: e.target.value })} />
                      </Field>
                    </div>
                    <div className="adm-question__tools">
                      <IconButton size="sm" label="Move up" icon={<ArrowUp />} disabled={i === 0} onClick={() => move(i, -1)} />
                      <IconButton size="sm" label="Move down" icon={<ArrowDown />} disabled={i === questions.length - 1} onClick={() => move(i, 1)} />
                      <IconButton size="sm" variant="danger" label={`Remove question ${i + 1}`} icon={<Trash2 />} onClick={() => update({ questions: questions.filter((x) => x.id !== q.id) })} />
                    </div>
                  </div>
                  <div className="adm-question__body">
                    <Field label="Answer type">
                      <Select
                        value={q.type}
                        options={TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] }))}
                        onChange={(e) => {
                          const type = e.target.value as QuestionType;
                          setQuestion(q.id, { type, options: hasOptions(type) ? (q.options?.length ? q.options : ['Option 1', 'Option 2']) : undefined });
                        }}
                      />
                    </Field>
                    {hasOptions(q.type) ? (
                      <Field label="Choices" hint="One per line." error={optErr}>
                        <Textarea
                          rows={3}
                          autoGrow
                          value={(q.options ?? []).join('\n')}
                          onChange={(e) => setQuestion(q.id, { options: e.target.value.split('\n') })}
                          onBlur={() => setQuestion(q.id, { options: (q.options ?? []).map((o) => o.trim()).filter(Boolean) })}
                        />
                      </Field>
                    ) : (
                      <Field label="Hint inside the box" optional>
                        <Input value={q.placeholder ?? ''} maxLength={120} onChange={(e) => setQuestion(q.id, { placeholder: e.target.value })} />
                      </Field>
                    )}
                    <div className="adm-question__req">
                      <Switch size="sm" checked={q.required} onChange={(required) => setQuestion(q.id, { required })} label="Required" />
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <div>
          <Button variant="secondary" iconLeft={<Plus size={16} />} disabled={questions.length >= 20} onClick={add}>
            Add a question
          </Button>
        </div>
      </Section>
    </>
  );
}
