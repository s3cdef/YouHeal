/* ==========================================================================
   YOU HEAL — Atlas data: fields -> pairs -> points (two realms)
   The pairs below are illustrative examples drawn from the way practitioners
   describe the Goiz catalog and the Hervás quantum layer. Sandra's certified
   pair catalog governs the real session. Copy is bilingual (en / es).
   ========================================================================== */
(function(){
  'use strict';
  const YH = window.YH = window.YH || {};

  const I = {
    drop:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/></svg>',
    gut:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M7 4v5a5 5 0 0 0 10 0V4M9 20c-3 0-4-3-2-5s5-2 7 0 1 5-2 5"/></svg>',
    shield:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z"/></svg>',
    bone:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 8a2.5 2.5 0 1 1 3-3l5 5a2.5 2.5 0 1 1 3 3 2.5 2.5 0 1 1-3 3l-5-5a2.5 2.5 0 1 1-3-3z"/></svg>',
    brain: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 4a4 4 0 0 0-4 4v8a4 4 0 0 0 4 4 4 4 0 0 0 4-4V8a4 4 0 0 0-4-4zM12 4v16M8 10h8M8 14h8"/></svg>',
    heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.5-7 10-7 10z"/></svg>',
    axis:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2v20M5 7c4 2 10 2 14 0M5 17c4-2 10-2 14 0"/><circle cx="12" cy="12" r="3"/></svg>',
    wave:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 12c2-5 4-5 6 0s4 5 6 0 4-5 6 0 2 5 2 0"/></svg>'
  };

  YH.FIELDS = [
    { id:'hormonal', realm:'medical', icon:I.drop,
      name:{en:'Hormonal field',es:'Campo hormonal'}, tag:{en:'Endocrine balance',es:'Equilibrio endocrino'},
      desc:{en:'Pairs in this field support communication between glands, hormones and the nervous system.',
            es:'Los pares de este campo apoyan la comunicación entre glándulas, hormonas y sistema nervioso.'},
      pairs:[
        {id:'hypo-pit',a:'hypothalamus',b:'pituitary',name:{en:'Hypothalamus – Pituitary',es:'Hipotálamo – Hipófisis'},focus:{en:'Regulatory axis',es:'Eje regulador'},
         detail:{en:'The master axis of the endocrine system. Practitioners place this pair when sleep, appetite, temperature or cycle rhythm feel out of sync.',
                 es:'El eje maestro del sistema endocrino. Se coloca cuando el sueño, el apetito, la temperatura o el ritmo del ciclo se sienten desincronizados.'}},
        {id:'thy-adr',a:'thyroid',b:'adrenalL',name:{en:'Thyroid – Adrenal',es:'Tiroides – Suprarrenal'},focus:{en:'Metabolic balance',es:'Equilibrio metabólico'},
         detail:{en:'Energy production meets stress response. A common pair for fatigue that rest does not fix.',
                 es:'La producción de energía se encuentra con la respuesta al estrés. Un par frecuente en la fatiga que el descanso no resuelve.'}},
        {id:'pan-ova',a:'pancreas',b:'ovaryR',name:{en:'Pancreas – Ovaries / Testes',es:'Páncreas – Ovarios / Testículos'},focus:{en:'Hormonal harmony',es:'Armonía hormonal'},
         detail:{en:'Blood-sugar rhythm and reproductive hormones influence each other. Often explored with cycle changes and cravings.',
                 es:'El ritmo del azúcar en sangre y las hormonas reproductivas se influyen mutuamente. Se explora con cambios del ciclo y antojos.'}},
        {id:'pin-med',a:'pineal',b:'medulla',name:{en:'Pineal – Medulla',es:'Pineal – Bulbo raquídeo'},focus:{en:'Circadian rhythm',es:'Ritmo circadiano'},
         detail:{en:'Light, melatonin and the brainstem. Two posterior points, placed with you lying face-up and the magnets slipped under the head and neck.',
                 es:'Luz, melatonina y tronco encefálico. Dos puntos posteriores: se colocan contigo boca arriba y los imanes bajo la cabeza y el cuello.'}}
      ]},
    { id:'digestive', realm:'medical', icon:I.gut,
      name:{en:'Digestive field',es:'Campo digestivo'}, tag:{en:'Assimilation and gut health',es:'Asimilación y salud intestinal'},
      desc:{en:'Supports microbiome balance, digestion and nutrient flow from stomach to colon.',
            es:'Apoya el equilibrio del microbioma, la digestión y el flujo de nutrientes del estómago al colon.'},
      pairs:[
        {id:'liv-liv',a:'liver',b:'liverP',name:{en:'Liver – Liver',es:'Hígado – Hígado'},focus:{en:'Detox and metabolism',es:'Depuración y metabolismo'},
         detail:{en:'An anterior and a posterior point on the same organ. One of the most frequently placed pairs in the catalog.',
                 es:'Un punto anterior y uno posterior sobre el mismo órgano. Uno de los pares que más se colocan en el catálogo.'}},
        {id:'sto-pyl',a:'stomach',b:'pylorus',name:{en:'Stomach – Pylorus',es:'Estómago – Píloro'},focus:{en:'Gastric rhythm',es:'Ritmo gástrico'},
         detail:{en:'Reflux, heaviness after meals, and the valve that times emptying into the small intestine.',
                 es:'Reflujo, pesadez después de comer y la válvula que regula el vaciado al intestino delgado.'}},
        {id:'col-col',a:'colonR',b:'colonL',name:{en:'Ascending – Descending colon',es:'Colon ascendente – descendente'},focus:{en:'Transit and microbiome',es:'Tránsito y microbioma'},
         detail:{en:'The two long sides of the large intestine. Explored with bloating, irregular transit and gut-related skin changes.',
                 es:'Los dos lados largos del intestino grueso. Se explora con hinchazón, tránsito irregular y cambios en la piel de origen intestinal.'}},
        {id:'pan-adr',a:'pancreas',b:'adrenalR',name:{en:'Pancreas – Adrenal',es:'Páncreas – Suprarrenal'},focus:{en:'Blood-sugar rhythm',es:'Ritmo del azúcar'},
         detail:{en:'Insulin meets cortisol. Often paired with the hormonal field when energy swings through the day.',
                 es:'La insulina se encuentra con el cortisol. Suele combinarse con el campo hormonal cuando la energía sube y baja durante el día.'}}
      ]},
    { id:'immune', realm:'medical', icon:I.shield,
      name:{en:'Immune field',es:'Campo inmune'}, tag:{en:'Defense and lymphatic flow',es:'Defensa y flujo linfático'},
      desc:{en:'Where the method began. Thymus, spleen, lungs and the lymphatic tissue of the gut.',
            es:'Donde comenzó el método. Timo, bazo, pulmones y el tejido linfático del intestino.'},
      pairs:[
        {id:'thy-rec',a:'thymus',b:'rectum',name:{en:'Thymus – Rectum',es:'Timo – Recto'},focus:{en:'The first pair, 1988',es:'El primer par, 1988'},
         detail:{en:'The pair Dr. Goiz identified in 1988, the origin of the whole catalog. The thymus point sits behind the upper sternum; the rectum point is posterior.',
                 es:'El par que el Dr. Goiz identificó en 1988, origen de todo el catálogo. El punto del timo está detrás del esternón superior; el del recto es posterior.'}},
        {id:'spl-spl',a:'spleen',b:'spleenP',name:{en:'Spleen – Spleen',es:'Bazo – Bazo'},focus:{en:'Lymphatic filtering',es:'Filtrado linfático'},
         detail:{en:'The body\'s largest lymphatic organ, anterior and posterior points. Explored with slow recovery and frequent colds.',
                 es:'El órgano linfático más grande del cuerpo, puntos anterior y posterior. Se explora con recuperación lenta y resfriados frecuentes.'}},
        {id:'lun-lun',a:'lungR',b:'lungL',name:{en:'Lung – Lung',es:'Pulmón – Pulmón'},focus:{en:'Breath and defense',es:'Respiración y defensa'},
         detail:{en:'Left and right lung fields. Often placed during seasonal changes or after respiratory illness.',
                 es:'Campos pulmonares izquierdo y derecho. Se coloca con frecuencia en cambios de estación o después de una enfermedad respiratoria.'}},
        {id:'app-col',a:'appendix',b:'colonR',name:{en:'Appendix – Ascending colon',es:'Apéndice – Colon ascendente'},focus:{en:'Gut immunity',es:'Inmunidad intestinal'},
         detail:{en:'Lymphoid tissue at the start of the large intestine. Pairs the immune and digestive fields.',
                 es:'Tejido linfoide al inicio del intestino grueso. Une los campos inmune y digestivo.'}}
      ]},
    { id:'structure', realm:'medical', icon:I.bone,
      name:{en:'Pain and structure',es:'Dolor y estructura'}, tag:{en:'Structural integrity',es:'Integridad estructural'},
      desc:{en:'Supports muscles, joints, spine and inflammatory balance.',
            es:'Apoya músculos, articulaciones, columna y el equilibrio inflamatorio.'},
      pairs:[
        {id:'hip-hip',a:'hipR',b:'hipL',name:{en:'Hip – Hip',es:'Cadera – Cadera'},focus:{en:'Pelvic alignment',es:'Alineación pélvica'},
         detail:{en:'The pelvis is where the leg-length response is read during the scan, so this pair is often checked first.',
                 es:'En la pelvis se lee la respuesta de acortamiento de pierna durante el rastreo, por eso este par suele revisarse primero.'}},
        {id:'kne-kne',a:'kneeR',b:'kneeL',name:{en:'Knee – Knee',es:'Rodilla – Rodilla'},focus:{en:'Joint load',es:'Carga articular'},
         detail:{en:'Weight-bearing joints. Explored with stiffness, old sports injuries and stairs that feel harder than they should.',
                 es:'Articulaciones de carga. Se explora con rigidez, lesiones deportivas antiguas y escaleras que cuestan más de lo normal.'}},
        {id:'sho-sho',a:'shoulderR',b:'shoulderL',name:{en:'Shoulder – Shoulder',es:'Hombro – Hombro'},focus:{en:'Upper girdle',es:'Cintura escapular'},
         detail:{en:'Desk tension and carrying strain gather here. Often paired with the temples in the nervous field.',
                 es:'Aquí se acumula la tensión del escritorio y de cargar peso. Suele combinarse con las sienes en el campo nervioso.'}},
        {id:'sac-coc',a:'sacrum',b:'coccyx',name:{en:'Sacrum – Coccyx',es:'Sacro – Cóccix'},focus:{en:'Lumbar base',es:'Base lumbar'},
         detail:{en:'Two posterior points at the base of the spine. Placed with the magnets under the body while you lie face-up.',
                 es:'Dos puntos posteriores en la base de la columna. Los imanes se ubican debajo del cuerpo mientras estás boca arriba.'}}
      ]},
    { id:'nervous', realm:'medical', icon:I.brain,
      name:{en:'Nervous field',es:'Campo nervioso'}, tag:{en:'Calm, focus and sleep',es:'Calma, enfoque y sueño'},
      desc:{en:'Head, brainstem and the autonomic rhythm between alert and rest.',
            es:'Cabeza, tronco encefálico y el ritmo autónomo entre alerta y descanso.'},
      pairs:[
        {id:'tem-tem',a:'templeR',b:'templeL',name:{en:'Temple – Temple',es:'Sien – Sien'},focus:{en:'Headaches and tension',es:'Dolor de cabeza y tensión'},
         detail:{en:'A bilateral pair at the temples. One of the most relaxing placements; many people fall asleep here.',
                 es:'Un par bilateral en las sienes. Una de las colocaciones más relajantes; muchas personas se duermen aquí.'}},
        {id:'cer-med',a:'cerebellum',b:'medulla',name:{en:'Cerebellum – Medulla',es:'Cerebelo – Bulbo raquídeo'},focus:{en:'Balance and reflexes',es:'Equilibrio y reflejos'},
         detail:{en:'Two posterior points at the back of the head and neck. Explored with dizziness, coordination and sleep onset.',
                 es:'Dos puntos posteriores en la nuca. Se explora con mareo, coordinación e inicio del sueño.'}},
        {id:'med-sac',a:'medulla',b:'sacrum',name:{en:'Medulla – Sacrum',es:'Bulbo – Sacro'},focus:{en:'Autonomic axis',es:'Eje autónomo'},
         detail:{en:'Top and bottom of the spinal cord. A long pair used when the body stays in alert mode.',
                 es:'Extremos superior e inferior de la médula espinal. Un par largo que se usa cuando el cuerpo se queda en modo alerta.'}}
      ]},
    { id:'renal', realm:'medical', icon:I.heart,
      name:{en:'Renal and circulatory',es:'Renal y circulatorio'}, tag:{en:'Filtration and pressure',es:'Filtración y presión'},
      desc:{en:'Kidneys, adrenals, bladder and the pressure system they regulate.',
            es:'Riñones, suprarrenales, vejiga y el sistema de presión que regulan.'},
      pairs:[
        {id:'kid-kid',a:'kidneyR',b:'kidneyL',name:{en:'Kidney – Kidney',es:'Riñón – Riñón'},focus:{en:'Filtration and fluid balance',es:'Filtración y equilibrio de líquidos'},
         detail:{en:'A classic bilateral pair on two posterior points. Explored with fluid retention, lower-back heaviness and fatigue.',
                 es:'Un par bilateral clásico sobre dos puntos posteriores. Se explora con retención de líquidos, pesadez lumbar y fatiga.'}},
        {id:'adr-adr',a:'adrenalR',b:'adrenalL',name:{en:'Adrenal – Adrenal',es:'Suprarrenal – Suprarrenal'},focus:{en:'Stress hormones',es:'Hormonas del estrés'},
         detail:{en:'The glands that sit on top of the kidneys and drive the stress response. Often placed with the thyroid pair.',
                 es:'Las glándulas sobre los riñones que impulsan la respuesta al estrés. Suele colocarse con el par de tiroides.'}},
        {id:'bla-pro',a:'bladder',b:'prostate',name:{en:'Bladder – Prostate / Uterus',es:'Vejiga – Próstata / Útero'},focus:{en:'Pelvic floor',es:'Piso pélvico'},
         detail:{en:'Two close anterior points low in the pelvis. Explored with urinary frequency and pelvic discomfort.',
                 es:'Dos puntos anteriores cercanos en la parte baja de la pelvis. Se explora con frecuencia urinaria y molestias pélvicas.'}}
      ]},
    /* ----- Quantum realm (Hervás) ----- */
    { id:'axes', realm:'quantum', icon:I.axis,
      name:{en:'Energetic axes',es:'Ejes energéticos'}, tag:{en:'Quantum layer · Hervás',es:'Capa cuántica · Hervás'},
      desc:{en:'In Quantum Biomagnetism the pair is read along the body\'s central axis and energy centers, not only organ to organ.',
            es:'En el Biomagnetismo Cuántico el par se lee a lo largo del eje central y los centros de energía, no solo de órgano a órgano.'},
      pairs:[
        {id:'cro-roo',a:'crown',b:'root',name:{en:'Crown – Root',es:'Corona – Raíz'},focus:{en:'Central axis',es:'Eje central'},
         detail:{en:'The longest pair on the body. Used to open and close a quantum session and to anchor the client before emotional work.',
                 es:'El par más largo del cuerpo. Se usa para abrir y cerrar una sesión cuántica y para anclar al cliente antes del trabajo emocional.'}},
        {id:'hea-sol',a:'heartCenter',b:'solarPlexus',name:{en:'Heart center – Solar plexus',es:'Centro del corazón – Plexo solar'},focus:{en:'Heart–plexus bridge',es:'Puente corazón–plexo'},
         detail:{en:'Where felt emotion meets the gut. The quantum layer reads this bridge for stored stress patterns.',
                 es:'Donde la emoción sentida se encuentra con el abdomen. La capa cuántica lee este puente en busca de patrones de estrés guardados.'}},
        {id:'bro-cer',a:'brow',b:'cerebellum',name:{en:'Brow – Cerebellum',es:'Entrecejo – Cerebelo'},focus:{en:'Vision and memory axis',es:'Eje de visión y memoria'},
         detail:{en:'Front and back of the head. Explored with rumination, visual strain and the mind that will not settle.',
                 es:'Frente y parte posterior de la cabeza. Se explora con rumiación, fatiga visual y una mente que no se aquieta.'}}
      ]},
    { id:'memory', realm:'quantum', icon:I.wave,
      name:{en:'Emotional and cellular memory',es:'Memoria emocional y celular'}, tag:{en:'Quantum layer · Hervás',es:'Capa cuántica · Hervás'},
      desc:{en:'Hervás extends the pair to emotional memory and energetic fields, working the physical, energetic and mental levels together.',
            es:'Hervás extiende el par a la memoria emocional y los campos energéticos, trabajando a la vez los niveles físico, energético y mental.'},
      pairs:[
        {id:'sol-kid',a:'solarPlexus',b:'kidneyL',name:{en:'Solar plexus – Kidney',es:'Plexo solar – Riñón'},focus:{en:'Fear and security',es:'Miedo y seguridad'},
         detail:{en:'A quantum-layer pair read when old fear patterns keep the body braced.',
                 es:'Un par de la capa cuántica que se lee cuando patrones antiguos de miedo mantienen el cuerpo en tensión.'}},
        {id:'hea-thy',a:'heartCenter',b:'thymus',name:{en:'Heart center – Thymus',es:'Centro del corazón – Timo'},focus:{en:'Grief and protection',es:'Duelo y protección'},
         detail:{en:'Emotional weight and immune defense sit next to each other in the chest. Often placed after loss.',
                 es:'El peso emocional y la defensa inmune están uno al lado del otro en el pecho. Suele colocarse después de una pérdida.'}},
        {id:'bro-med',a:'brow',b:'medulla',name:{en:'Brow – Medulla',es:'Entrecejo – Bulbo'},focus:{en:'Rumination and sleep',es:'Rumiación y sueño'},
         detail:{en:'The thinking mind and the brainstem that should let it rest. Explored with racing thoughts at night.',
                 es:'La mente que piensa y el tronco encefálico que debería dejarla descansar. Se explora con pensamientos acelerados en la noche.'}}
      ]}
  ];

  YH.REALMS = {
    medical:{name:{en:'Medical Biomagnetism',es:'Biomagnetismo Médico'}, who:{en:'Dr. Isaac Goiz Durán · 1988',es:'Dr. Isaac Goiz Durán · 1988'},
      note:{en:'Organ-to-organ pairs read through the leg-length response. Level 1 and Level 2 catalogs, plus Bioenergetics.',
            es:'Pares de órgano a órgano leídos con la respuesta de acortamiento de pierna. Catálogos de Nivel 1 y Nivel 2, más Bioenergética.'}},
    quantum:{name:{en:'Quantum Biomagnetism',es:'Biomagnetismo Cuántico'}, who:{en:'Dr. Avelino Hervás · 2014',es:'Dr. Avelino Hervás · 2014'},
      note:{en:'Adds energetic axes, cellular memory and the emotional layer. Enables remote scanning and the quantum table.',
            es:'Agrega ejes energéticos, memoria celular y la capa emocional. Permite el rastreo a distancia y la mesa cuántica.'}}
  };
})();
