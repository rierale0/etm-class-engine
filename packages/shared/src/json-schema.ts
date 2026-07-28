export const classAnalysisJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schema_version',
    'metadata',
    'language',
    'estimated_level',
    'summary',
    'learning_objectives',
    'sections',
    'key_concepts',
    'vocabulary',
    'grammar',
    'pronunciation',
    'teacher_corrections',
    'student_difficulties',
    'visual_materials',
    'suggested_exercises',
    'next_steps',
    'transcript',
    'processing_warning',
  ],
  properties: {
    schema_version: { type: 'integer', const: 1 },
    metadata: object(
      [
        'video_id',
        'video_url',
        'title',
        'class_date',
        'teacher',
        'course',
        'duration_seconds',
        'processed_at',
        'transcription_model',
        'analysis_model',
        'visual_analysis_enabled',
      ],
      {
        video_id: string(),
        video_url: string(),
        title: string(),
        class_date: string(),
        teacher: string(),
        course: string(),
        duration_seconds: { type: 'number' },
        processed_at: string(),
        transcription_model: string(),
        analysis_model: string(),
        visual_analysis_enabled: { type: 'boolean' },
      },
    ),
    language: string(),
    estimated_level: string(),
    summary: string(),
    learning_objectives: array(string()),
    sections: array(
      object(['start', 'end', 'title', 'summary', 'visual_context'], {
        start: string(),
        end: string(),
        title: string(),
        summary: string(),
        visual_context: string(),
      }),
    ),
    key_concepts: array(
      object(['concept', 'explanation', 'examples'], {
        concept: string(),
        explanation: string(),
        examples: array(string()),
      }),
    ),
    vocabulary: array(
      object(['term', 'meaning', 'example', 'timestamp'], {
        term: string(),
        meaning: string(),
        example: string(),
        timestamp: string(),
      }),
    ),
    grammar: array(
      object(['topic', 'explanation', 'examples', 'timestamp'], {
        topic: string(),
        explanation: string(),
        examples: array(string()),
        timestamp: string(),
      }),
    ),
    pronunciation: array(
      object(['item', 'guidance', 'timestamp'], {
        item: string(),
        guidance: string(),
        timestamp: string(),
      }),
    ),
    teacher_corrections: array(
      object(['original', 'correction', 'explanation', 'timestamp'], {
        original: string(),
        correction: string(),
        explanation: string(),
        timestamp: string(),
      }),
    ),
    student_difficulties: array(string()),
    visual_materials: array(
      object(['timestamp', 'description', 'relevance'], {
        timestamp: string(),
        description: string(),
        relevance: string(),
      }),
    ),
    suggested_exercises: array(
      object(['instruction', 'answer_or_key'], {
        instruction: string(),
        answer_or_key: string(),
      }),
    ),
    next_steps: array(string()),
    transcript: string(),
    processing_warning: { type: ['string', 'null'] },
  },
} as const;

function string() {
  return { type: 'string' } as const;
}

function array(items: unknown) {
  return { type: 'array', items };
}

function object(required: string[], properties: Record<string, unknown>) {
  return { type: 'object', additionalProperties: false, required, properties };
}
