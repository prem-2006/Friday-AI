// Friday: a live strip of what Friday is doing in this turn.
import {
  CalendarDays,
  CircleCheck,
  CircleX,
  Globe,
  Hand,
  Loader2,
  Phone,
  Search,
} from 'lucide-react';
import { fridaySteps, type FridayStep } from './steps';
import './friday.css';

const ICONS: Record<FridayStep['kind'], typeof Search> = {
  research: Search,
  call: Phone,
  browser: Globe,
  calendar: CalendarDays,
  approval: Hand,
};

export function FridaySteps({
  messages,
}: {
  messages: Parameters<typeof fridaySteps>[0];
}) {
  const steps = fridaySteps(messages);
  if (!steps.length) return null;
  return (
    <ol className="friday-steps" aria-label="What Friday is doing">
      {steps.map((step) => {
        const Icon = ICONS[step.kind];
        return (
          <li key={step.kind} className={`friday-step ${step.state}`}>
            <Icon size={14} aria-hidden />
            <span className="friday-step-label">{step.label}</span>
            <span className="friday-step-detail">{step.detail}</span>
            {step.state === 'active' ? (
              <Loader2
                size={13}
                className="friday-spin"
                aria-label="In progress"
              />
            ) : step.state === 'done' ? (
              <CircleCheck size={13} aria-label="Done" />
            ) : step.state === 'failed' ? (
              <CircleX size={13} aria-label="Did not work" />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
