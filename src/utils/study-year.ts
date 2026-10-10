/// Study years a user can pick. PREPARATORY (السنة التحضيرية) is the one that
/// competes in "Mossad". Add more values here to support more years later.
export const STUDY_YEARS = ["PREPARATORY", "OTHER"] as const;
export type StudyYear = (typeof STUDY_YEARS)[number];

/// Year whose members are ranked together in the Mossad competition.
export const MOSSAD_YEAR: StudyYear = "PREPARATORY";
