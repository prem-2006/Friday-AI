// Friday: a way back to the voice stage from the classic OpenDots view.
import { AudioLines } from 'lucide-react';
import { STAGE_HASH } from './stage/FridayStage';
import './friday.css';

export function StageLink() {
  return (
    <a
      className="friday-stage-link"
      href={STAGE_HASH}
      aria-label="Open Friday voice"
    >
      <AudioLines size={18} />
      Voice
    </a>
  );
}
