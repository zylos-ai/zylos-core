# Inside Out (2015) Memory Model Research

## Overview

Pixar's *Inside Out* (2015) presents a richly detailed metaphorical model of human memory and emotion. The filmmakers consulted with neuroscientists and psychologists (notably Dr. Dacher Keltner of UC Berkeley and Dr. Paul Ekman) to ground the film's mechanisms in real cognitive science. This document catalogs each memory mechanism from the film, explains how it works narratively, and maps it to a concrete agent memory system concept.

---

## 1. Core Memories

### How It Works in the Movie

Core memories are special, intensely glowing memory orbs that represent the most significant experiences in Riley's life. They are visually brighter and more vivid than ordinary memories. When formed, a core memory rolls down a dedicated track to a circular tray at the center of Headquarters, where it emits a beam of light through a glass tube to power its corresponding Personality Island.

Riley starts with five core memories, all yellow (Joy-colored):
- **Family Island** core memory: Riley baking cookies and having fun with her parents
- **Honesty Island** core memory: Toddler Riley confessing to breaking a plate
- **Hockey Island** core memory: Riley scoring her first hockey goal with her family
- **Goofball Island** core memory: Riley running naked from bath, being silly
- **Friendship Island** core memory: Riley becoming best friends with Meg

A pivotal moment occurs when Sadness touches a core memory, turning it from gold to blue -- demonstrating that core memories can be emotionally re-colored by current emotional state. By the film's end, Riley's core memories become multicolored swirls, representing emotional complexity.

### Mapping to Agent Memory System

**Concept: Foundational Context Anchors / Identity Documents**

Core memories map to the agent's most essential, identity-defining context -- the documents that shape "who the agent is" and how it behaves. In the current Zylos system, these are analogous to:
- `CLAUDE.md` (behavioral identity)
- `memory/preferences.md` (user preferences that shape all interactions)
- `memory/decisions.md` (key decisions that constrain future behavior)

**Design implications:**
- Core memories should be stored separately from bulk memories, in a protected tier
- They should be loaded first during context initialization (like the core tray in Headquarters)
- They should be harder to delete or modify than regular memories
- Like the film, core memories "power" higher-level behavioral patterns (Personality Islands)

### Problem Solved vs. Naive File-Based Approach

A naive system treats all stored information equally. The core memory concept introduces **tiered importance** -- some memories fundamentally define behavior and identity while most are just recalled facts. Without this distinction, an agent might evict a critical preference or decision during context compression, losing its "personality."

---

## 2. Long-Term Memory

### How It Works in the Movie

Long-term memory is visualized as a vast, maze-like archive of towering shelves stretching as far as the eye can see. The corridors curve and bend to evoke the folds and wrinkles of the human brain. Millions of memory orbs sit on these shelves, organized loosely by category.

Each night when Riley falls asleep, the day's memory orbs are vacuumed out of Headquarters through tubes and transported to long-term storage. Mind Workers maintain the shelves, and the Forgetters periodically remove faded orbs. Joy and Sadness spend much of the film navigating this labyrinth, demonstrating how vast and difficult-to-traverse it can be.

The sheer scale is important: Joy describes it as containing "millions" of memories, and even she -- an emotion who lives in the mind -- can get lost in it.

### Mapping to Agent Memory System

**Concept: Persistent Knowledge Store (Knowledge Base / Vector Database)**

Long-term memory maps directly to the agent's persistent storage layer -- the knowledge base, database, or file archive that persists across sessions. In Zylos, this is:
- The SQLite FTS5 knowledge base (`~/zylos/knowledge-base/`)
- The `~/zylos/memory/` directory of markdown files
- Git history (an immutable long-term archive)

**Design implications:**
- Must support efficient retrieval despite enormous scale (the maze problem)
- Needs organizational structure (categories, tags, embeddings) not just flat storage
- Requires a consolidation process that runs during "downtime" (the nightly vacuum)
- Should be browsable but with search/retrieval mechanisms since manual traversal is impractical

### Problem Solved vs. Naive File-Based Approach

A flat file system (e.g., dumping everything into a single `notes.txt`) makes retrieval impossibly slow at scale. The long-term memory maze shows that even organized storage needs **retrieval mechanisms** (recall tubes, search). Without categorization and indexing, the agent "gets lost in its own archives" -- spending context window on searching rather than reasoning.

---

## 3. Short-Term / Working Memory (Headquarters)

### How It Works in the Movie

Headquarters is the control center of Riley's mind -- a bright room where the five emotions (Joy, Sadness, Anger, Fear, Disgust) operate a central console. It represents Riley's current conscious awareness.

Key properties:
- **Limited capacity**: Only a day's worth of memory orbs accumulate on the floor before being flushed to long-term storage at night
- **Direct control**: Emotions interact with a console that directly affects Riley's behavior and speech
- **Screen/viewport**: A large screen shows Riley's current perception of the real world
- **Core memory tray**: The central holder where core memories sit and power the islands

The console is upgraded at the end of the film to be larger, accommodating more complex emotional responses as Riley matures -- implying working memory can expand.

### Mapping to Agent Memory System

**Concept: Context Window / Active Session State**

Headquarters maps to the agent's **context window** -- the currently loaded information the agent can reason about. This is the most constrained resource:
- The active conversation in the LLM context window
- `memory/context.md` (the current work focus loaded at session start)
- Any files currently read into context

**Design implications:**
- Strictly limited in size (like the floor space in Headquarters)
- Must be periodically flushed to long-term storage (nightly consolidation = context compaction)
- The "console" represents the agent's ability to take actions -- it only works from Headquarters
- Emotions at the console = different reasoning modes or priorities competing for control of output

### Problem Solved vs. Naive File-Based Approach

Without a working memory concept, an agent either loads everything (impossible at scale) or loads nothing (no context). The Headquarters model shows that a small, curated subset of information must be actively maintained in the "hot" tier, with clear mechanisms for what enters and exits. It also shows that working memory contents directly determine behavior -- what's in context shapes what the agent does.

---

## 4. Emotional Coloring of Memories

### How It Works in the Movie

Every memory orb has a color corresponding to the dominant emotion present when it was formed:
- **Yellow** = Joy
- **Blue** = Sadness
- **Red** = Anger
- **Purple** = Fear
- **Green** = Disgust

Critically, memories can be **re-colored**. When Sadness touches a yellow memory orb, it turns blue -- the memory itself doesn't change, but its emotional valence shifts. A happy memory of Minnesota becomes a sad memory of what Riley lost. By the film's climax, Riley's memories become multicolored, representing emotional maturity -- the same event can hold multiple emotions simultaneously.

This is psychologically accurate: our emotional state during recall influences how we experience and reconsolidate memories (mood-congruent memory bias).

### Mapping to Agent Memory System

**Concept: Metadata Tags / Sentiment Annotations / Contextual Reframing**

Emotional coloring maps to rich metadata on stored memories:
- **Importance scores** (1-5 in the current KB system)
- **Emotional/sentiment tags** (urgent, positive, negative, neutral, deprecated)
- **Contextual reframing**: The same stored fact can be interpreted differently based on current context (a decision marked "good" at the time might be tagged "revisit" after new information)

**Design implications:**
- Memories should carry mutable metadata, not just immutable content
- The agent's current "emotional state" (priority mode, urgency level, user mood) should influence how stored memories are retrieved and weighted
- Support for multicolored / multi-tagged memories (a decision can be both "successful" and "costly")
- Re-evaluation mechanism: periodically re-score old memories under new context

### Problem Solved vs. Naive File-Based Approach

A naive system stores facts as flat text with no affect or importance metadata. The emotional coloring model shows that **how you feel about a memory matters as much as what the memory contains**. Without this, an agent can't prioritize retrieved information or adjust its interpretation based on current context. Every memory is treated with equal emotional weight, which is psychologically unrealistic and operationally unhelpful.

---

## 5. Memory Dump

### How It Works in the Movie

The Memory Dump is a vast, dark pit at the very bottom of Riley's mind. It's where memories go to die. The Forgetters (Mind Workers) vacuum up faded, gray memory orbs from the long-term memory shelves and send them down into the pit via vacuum tubes.

In the dump, memories gradually lose all remaining color, crumble into dust, and dissolve into nothingness -- they become permanently forgotten. This is irreversible.

The dump serves a crucial narrative role: when Joy and Bing Bong fall into it, Bing Bong (Riley's imaginary friend) sacrifices himself by fading away completely so Joy can escape. His last words -- "Take her to the moon for me" -- are among the most poignant in the film, dramatizing the emotional cost of forgetting.

When personality islands collapse (because their core memories are missing), their debris also falls into the Memory Dump, showing that losing core memories can destroy entire behavioral systems.

### Mapping to Agent Memory System

**Concept: Garbage Collection / TTL Expiration / Archival Deletion**

The Memory Dump maps to the agent's memory cleanup and deletion system:
- Automatic expiration of low-importance, unaccessed memories
- The "fade" process before deletion (grace period)
- Permanent deletion of entries that have fully decayed
- The emotional cost of forgetting = potential information loss

**Design implications:**
- Deletion should be gradual, not instant (fading = soft-delete before hard-delete)
- A "dump" or archive tier between active storage and true deletion
- Some mechanism should exist to "rescue" fading memories if they become relevant again (Joy climbed out of the dump)
- Core memories / high-importance entries should be immune to automatic garbage collection
- The system should log what was deleted for auditability

### Problem Solved vs. Naive File-Based Approach

A naive system either keeps everything forever (running out of storage, degrading search quality with stale results) or deletes aggressively (losing potentially valuable information). The Memory Dump model introduces a **graceful degradation pipeline**: memories fade gradually, are soft-deleted, then permanently removed. This prevents storage bloat while giving important-but-forgotten information a chance to be rescued.

---

## 6. Dream Production

### How It Works in the Movie

Dream Productions is a literal movie studio inside Riley's mind, staffed by Mind Workers who create Riley's dreams while she sleeps. It's set up like a Hollywood backlot with directors, cameras, sets, and actors.

The process works as follows:
1. Mind Workers pull disparate elements from Riley's recent memories
2. They mash these elements together into short "film" sketches
3. A "reality distortion" filter on their cameras warps the content
4. The resulting dream is projected/transmitted to Riley's sleeping consciousness
5. Dreams can be good (funny, exciting) or nightmares (scary, distressing)

In the film, Joy and Sadness disrupt Dream Productions to wake Riley up so they can use the Train of Thought (which only runs when Riley is awake). This scene shows dreams as a processing mechanism -- not just entertainment, but a way the mind makes sense of recent experiences.

### Mapping to Agent Memory System

**Concept: Background Memory Processing / Consolidation / Pattern Synthesis**

Dream Production maps to offline or background processing of stored memories:
- **Memory consolidation**: During "idle time," the agent reviews and reorganizes recent memories
- **Pattern synthesis**: Combining disparate memories to find connections (like Dream Productions mashing up unrelated memories)
- **Defragmentation**: Reorganizing storage for better retrieval
- **Insight generation**: The "reality distortion filter" = finding non-obvious patterns by combining memories in novel ways

In the current Zylos system, this could map to:
- The idle-time task scheduler running consolidation tasks
- Periodic KB reorganization and deduplication
- Generating summaries that synthesize related entries
- The continuous-learning workflow (researching and connecting new information to existing knowledge)

**Design implications:**
- Memory processing should happen during downtime, not during active interaction
- The system should actively combine and cross-reference memories, not just store them passively
- Some processing may produce "noise" (bad dreams) -- not all synthesized connections are valuable
- Processing can be interrupted if the agent needs to "wake up" for a user request

### Problem Solved vs. Naive File-Based Approach

A naive system stores memories and retrieves them but never processes them. The Dream Production model introduces **active memory maintenance** -- the system doesn't just archive, it actively recombines and synthesizes stored information to extract patterns and connections that weren't visible at storage time. Without this, an agent accumulates raw data but never develops "understanding."

---

## 7. Personality Islands

### How It Works in the Movie

Personality Islands are large, themed structures visible from Headquarters, floating above the Memory Dump. Each island is powered by one or more core memories and represents a major aspect of Riley's personality:

1. **Goofball Island** -- Riley's sense of humor and silliness (powered by the naked-bath-run memory)
2. **Hockey Island** -- Riley's athletic identity and competitive spirit
3. **Friendship Island** -- Riley's social connections and ability to bond
4. **Honesty Island** -- Riley's commitment to truth and integrity
5. **Family Island** -- Riley's family bonds and sense of belonging (described as the foundation of all islands)

When a core memory is removed from Headquarters, its corresponding island loses power and begins to crumble. During the film's crisis, islands collapse one by one:
- Hockey Island crumbles when Riley fails at hockey tryouts (she loses her athletic identity)
- Friendship Island falls when Riley is rude to Meg on video chat
- Honesty Island collapses when Riley steals her mother's credit card
- Family Island, the last and most fundamental, crumbles piece by piece as Riley runs away from home

Islands can be rebuilt: by the film's end, Riley has new, more complex islands powered by multicolored core memories, including an expanded Family Island and new ones.

### Mapping to Agent Memory System

**Concept: Behavioral Modules / Skill Domains / Personality Traits**

Personality Islands map to the agent's high-level behavioral capabilities and identity aspects:
- **Skills/capabilities** that the agent has developed (like Hockey Island = a specific competency)
- **Behavioral patterns** derived from accumulated experience (like Honesty Island = a behavioral constraint)
- **Domain expertise** built up from many related memories (like Family Island = deep context in a specific area)

In the current Zylos system:
- Skills in `~/.claude/skills/` (each is a "Personality Island" of capability)
- Behavioral patterns defined in `CLAUDE.md`
- Domain knowledge clusters in the knowledge base

**Design implications:**
- High-level behaviors should be explicitly derived from (and linked to) core memories
- If foundational context is lost, the dependent behavioral capability collapses
- The agent should be able to build new behavioral modules as it accumulates experience
- Islands/modules should be visible and inspectable (the emotions can see them from Headquarters)
- Damaged capabilities should be rebuildable with new core memories

### Problem Solved vs. Naive File-Based Approach

A naive system has no concept of emergent behavioral capabilities built from experience. The Personality Island model shows that **accumulated memories produce higher-order capabilities** -- it's not just about storing facts, but about how clusters of related memories enable complex behaviors. Without this, an agent can recall information but can't develop expertise or behavioral consistency in specific domains.

---

## 8. Memory Recall (Tubes and Train of Thought)

### How It Works in the Movie

Two main retrieval mechanisms exist:

**Recall Tubes**: Pneumatic tubes that can shoot individual memory orbs from long-term memory back to Headquarters on demand. Mind Workers occasionally use these to send random memories up -- like the annoying "Triple Dent Gum" jingle that keeps getting sent back to Headquarters involuntarily. Joy also attempts to ride a recall tube back to Headquarters at one point (it fails when the ground collapses).

**Train of Thought**: A literal train that travels along tracks through the mind, carrying daydreams, ideas, facts, and opinions between different regions. It has no fixed schedule or path. Critically, the Train of Thought only runs when Riley is awake -- when she falls asleep, the train stops and its tracks disassemble.

The film also shows that facts and opinions get mixed up on the train, and that involuntary recall (the gum jingle) can be intrusive and unwanted.

### Mapping to Agent Memory System

**Concept: Retrieval Mechanisms (Search, Associative Recall, Streaming)**

The two mechanisms map to different retrieval patterns:

**Recall Tubes = Direct/targeted retrieval:**
- FTS5 keyword search (`kb-cli search "query"`)
- `grep` for specific content in memory files
- Retrieving a specific entry by ID
- Fast, targeted, returns specific items

**Train of Thought = Associative/streaming retrieval:**
- Browsing related entries and following connections
- The chain of reasoning that connects one memory to another
- Background processes that surface relevant information
- Slower, less targeted, but can transport complex multi-part information

**Design implications:**
- Multiple retrieval mechanisms needed (not just one search interface)
- Support for both targeted recall ("get me that specific memory") and associative recall ("what's related to this topic?")
- Involuntary recall mechanism: some memories should surface automatically based on context triggers
- Retrieval should only work during active sessions (Train stops when Riley sleeps = no retrieval during offline)
- Facts and opinions should be clearly distinguished in storage to avoid mixing them up

### Problem Solved vs. Naive File-Based Approach

A naive system provides only one retrieval mechanism (e.g., filename lookup). The recall model shows that agents need **multiple retrieval pathways** -- sometimes you need a specific fact (recall tube), sometimes you need to follow a chain of associations (train of thought), and sometimes memories surface involuntarily based on context (the gum jingle). Without diverse retrieval, the agent either can't find what it needs or retrieves irrelevant information.

---

## 9. Memory Fading

### How It Works in the Movie

Memory orbs gradually lose their color and glow over time if they aren't recalled or reinforced. The process is:

1. **Vibrant**: Freshly formed memory, bright and colorful
2. **Dimming**: Memory begins to lose intensity, colors become muted
3. **Gray**: Memory has lost nearly all emotional coloring, appears dull and lifeless
4. **Swept away**: Forgetters vacuum gray orbs off the shelves and send them to the Memory Dump

The Forgetters (specifically Bobby and Paula) actively patrol long-term memory, identifying faded orbs for removal. They seem to have criteria for what to keep vs. discard, though their judgment is sometimes questionable (they keep sending up the "Triple Dent Gum" jingle because it's catchy, not because it's important).

Bing Bong's entire character arc illustrates fading: once a vibrant, beloved imaginary friend, he has faded from Riley's active memory and been relegated to the far corners of long-term storage, and ultimately to the dump where he dissolves entirely.

### Mapping to Agent Memory System

**Concept: Decay Functions / Access-Based Retention / TTL (Time-To-Live)**

Memory fading maps to a decay and retention system:
- **Recency weighting**: Recently accessed memories rank higher in retrieval
- **Access frequency tracking**: Memories that are recalled often stay "vibrant" (retain high importance)
- **Time-based decay**: Memories gradually decrease in retrieval priority over time
- **Active cleanup**: A background process (Forgetters) identifies and removes low-value, decayed memories

**Design implications:**
- Every memory entry should have `last_accessed` and `access_count` metadata
- Importance scores should decay over time unless refreshed by access
- A "Forgetter" background process should periodically scan for stale entries
- Fading should be gradual: reduce importance score before archiving, archive before deleting
- Some memories resist fading (core memories, high-importance entries) regardless of access patterns
- "Catchy" low-importance memories (gum jingle) illustrate that access-based retention alone isn't sufficient -- quality/relevance must also factor in

### Problem Solved vs. Naive File-Based Approach

A naive system either keeps everything forever (storage bloat, search pollution) or uses simple timestamp-based deletion (losing rarely-accessed but valuable information). The fading model introduces **nuanced decay** that considers recency, frequency, and importance together. A memory can be old but still vivid if it's frequently accessed or inherently important. This prevents both bloat and premature loss of valuable information.

---

## 10. Abstract Thought

### How It Works in the Movie

Abstract Thought is a processing corridor that simplifies complex concepts so Riley can understand them. When Joy, Sadness, and Bing Bong accidentally enter while it's active, they undergo four stages of forced abstraction:

1. **Non-objective Fragmentation**: Characters break into Picasso-like fragments -- individual pieces of the whole separate but remain recognizable
2. **Deconstruction**: The fragments further decompose -- parts literally fall away from each other
3. **Two-Dimensionalization**: Characters flatten from 3D to 2D representations
4. **Non-figurative**: Characters are reduced to simple colored shapes (blobs) -- pure abstraction with no resemblance to original form

They narrowly escape before being fully abstracted. The scene is played for comedy (Joy becomes a flat shape, Bing Bong a collection of abstract forms) but represents a real cognitive process: as we mature, we develop the ability to think in increasingly abstract terms, moving from concrete objects to abstract concepts.

### Mapping to Agent Memory System

**Concept: Summarization Pipeline / Progressive Compression / Abstraction Layers**

Abstract Thought maps to how the agent compresses detailed memories into increasingly abstract representations:

1. **Non-objective Fragmentation** = Extracting key facts from a detailed memory (picking out the important pieces)
2. **Deconstruction** = Breaking extracted facts into independent, reusable units (decontextualizing)
3. **Two-Dimensionalization** = Summarizing into a flat, compact representation (one-line summaries, bullet points)
4. **Non-figurative** = Reducing to pure metadata/tags (just a category label and importance score)

In the current Zylos system:
- Full learning documents in `~/zylos/learning/` = raw memory
- KB entries with content summaries = fragmented/deconstructed
- KB tags and categories = two-dimensional representations
- KB stats/counts = fully abstracted (non-figurative)

**Design implications:**
- Memory system needs multiple levels of abstraction, not just raw storage
- Compression pipeline: raw -> summary -> keywords -> tags -> stats
- Different retrieval needs call for different abstraction levels
- Over-abstraction loses critical detail (the characters almost ceased to exist) -- there must be a way to access the original raw memory when needed
- The process should be controllable (they escaped the corridor) -- not every memory should be fully abstracted

### Problem Solved vs. Naive File-Based Approach

A naive system stores either full raw text or nothing. The Abstract Thought model introduces a **progressive compression pipeline** where the same memory exists at multiple abstraction levels simultaneously. Need a quick overview? Read the tag. Need detail? Access the full document. This allows the agent to efficiently scan thousands of memories at the abstract level while retaining the ability to drill down when needed -- crucial for operating within a limited context window.

---

## Summary Table

| # | Movie Mechanism | Agent Memory Concept | Key Problem Solved |
|---|----------------|---------------------|-------------------|
| 1 | Core Memories | Identity anchors / foundational context | Tiered importance prevents critical context loss during compression |
| 2 | Long-Term Memory | Persistent knowledge store (KB/DB) | Organized, categorized archival storage with retrieval mechanisms |
| 3 | Headquarters (Working Memory) | Context window / active session | Bounded working set with flush-to-storage lifecycle |
| 4 | Emotional Coloring | Mutable metadata / sentiment tags | Context-sensitive interpretation and prioritization of memories |
| 5 | Memory Dump | Garbage collection / graceful deletion | Gradual cleanup prevents both bloat and premature loss |
| 6 | Dream Production | Background processing / consolidation | Active synthesis finds patterns across stored memories |
| 7 | Personality Islands | Behavioral modules / skill domains | Emergent capabilities built from clustered memories |
| 8 | Recall Tubes + Train | Multiple retrieval pathways | Targeted search + associative browsing + involuntary surfacing |
| 9 | Memory Fading | Decay functions / access-based retention | Nuanced retention balancing recency, frequency, and importance |
| 10 | Abstract Thought | Summarization pipeline / compression levels | Multi-level abstraction for efficient scanning with drill-down capability |

---

## Key Architectural Insights

### 1. Memory Is Not Flat Storage
The film's most important lesson: memory is a **living system** with multiple tiers, active maintenance processes, and emergent properties. It's closer to a managed database with background jobs than a file system.

### 2. Emotion (Metadata) Is Inseparable from Memory
Every memory in Inside Out has emotional coloring. Similarly, every entry in an agent memory system needs rich metadata -- importance, context, sentiment, relationships, access patterns. Raw content alone is insufficient.

### 3. Forgetting Is Essential, Not Failure
The Memory Dump is not a bug -- it's a feature. Active, intelligent forgetting (garbage collection) is necessary for a healthy memory system. The tragedy of Bing Bong shows the emotional cost, but the system would be dysfunctional without it.

### 4. Sleep/Idle Time Is for Processing
The nightly consolidation cycle (vacuuming memories to long-term storage, running Dream Productions) maps directly to idle-time maintenance tasks in an agent system. Processing should happen during downtime, not during active interaction.

### 5. Core Memories Need Special Protection
The entire crisis in the film stems from core memories being accidentally removed from Headquarters. The agent equivalent: if foundational context files are corrupted, deleted, or evicted from the context window, the agent's behavioral capabilities (Personality Islands) collapse.

### 6. Multiple Retrieval Paths Are Necessary
Recall tubes (targeted), Train of Thought (associative), and involuntary recall (contextual triggers) serve different needs. An agent needs search, browsing, and automatic context-sensitive surfacing.

### 7. Abstraction Is a Spectrum
Abstract Thought shows that information can exist at multiple levels of compression simultaneously. An agent should maintain raw memories alongside summaries, keywords, and pure metadata -- accessing the appropriate level based on the task.

---

## Sources

- [Core Memories - Inside Out Wiki (Fandom)](https://insideout.fandom.com/wiki/Core_Memories)
- [Islands of Personality - Inside Out Wiki (Fandom)](https://insideout.fandom.com/wiki/Islands_of_Personality)
- [Long Term Memory - Inside Out Wiki (Fandom)](https://insideout.fandom.com/wiki/Long_Term_Memory)
- [Abstract Thought - Inside Out Wiki (Fandom)](https://insideout.fandom.com/wiki/Abstract_Thought)
- [Memory Orbs - Pixar Wiki (Fandom)](https://pixar.fandom.com/wiki/Memory_Orbs)
- [The Forgetters - Disney Wiki (Fandom)](https://disney.fandom.com/wiki/The_Forgetters)
- [Memory Dump - Disney Wiki (Fandom)](https://disney.fandom.com/wiki/Memory_Dump)
- [Dream Productions - Disney Wiki (Fandom)](https://disney.fandom.com/wiki/Dream_Productions)
- [Bing Bong - Inside Out Wiki (Fandom)](https://insideout.fandom.com/wiki/Bing_Bong)
- [Does Pixar's Inside Out show how memory actually works? - The Conversation](https://theconversation.com/does-pixars-inside-out-show-how-memory-actually-works-43311)
- [Pixar's Inside Out is a surprisingly accurate representation of memory - Quartz](https://qz.com/434464/does-pixars-inside-out-show-how-memory-actually-works)
- [Inside Out's Take on the Brain - Dr. Blake Porter](https://www.blakeporterneuro.com/inside-outs-take-on-the-brain-a-neuroscientists-perspective/)
- [A Guide to Inside Out's Complex Mind Machine - Tumblr](https://www.tumblr.com/jordan-zakarin/122196135691/a-guide-to-inside-outs-complex-mind-machine)
- [Every Core Memory Riley Has - Screen Rant](https://screenrant.com/every-core-memory-riley-has-in-the-inside-out-movies/)
- [Memories Shape Personalities - USU Digital Exhibits](http://exhibits.usu.edu/exhibits/show/jenna/memories)
- [An Illustration of Human Memory with Inside Out - Cherwell](https://cherwell.org/2021/02/09/an-illustration-of-human-memory-with-inside-out/)
- [Inside Out (2015 film) - Wikipedia](https://en.wikipedia.org/wiki/Inside_Out_(2015_film))
